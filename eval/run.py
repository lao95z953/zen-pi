#!/usr/bin/env python3
"""Capture reproducible Pi task runs; semantic rubric scoring remains explicit human review."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import queue
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time


def load_suite(path):
    suite = json.loads(Path(path).read_text())

    def require(condition, message):
        if not condition:
            raise ValueError(f"Invalid suite: {message}")

    def note_path(name):
        require(isinstance(name, str) and bool(name) and "\0" not in name, "note path must be text")
        p = Path(name)
        require(not p.is_absolute() and ".." not in p.parts and p.suffix == ".md", "note path must stay inside the synthetic vault")

    require(isinstance(suite, dict) and suite.get("version") == 1, "unsupported version")
    require(isinstance(suite.get("notes"), dict), "notes must be an object")
    require(isinstance(suite.get("cases"), list) and bool(suite["cases"]), "cases must be a nonempty list")
    ids = set()
    for name, text in suite["notes"].items():
        note_path(name)
        require(isinstance(text, str), "note content must be text")
    for case in suite["cases"]:
        require(isinstance(case, dict) and isinstance(case.get("id"), str), "case ID must be text")
        require(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", case["id"]), "unsafe case ID")
        require(case["id"] not in ids, "duplicate case ID")
        require(isinstance(case.get("criteria"), list) and bool(case["criteria"]) and
                all(isinstance(c, str) and c.strip() for c in case["criteria"]), "criteria must contain text")
        require(isinstance(case.get("turns"), list) and bool(case["turns"]), "turns must be a nonempty list")
        ids.add(case["id"])
        for turn in case["turns"]:
            require(isinstance(turn, dict) and len(turn) == 1 and next(iter(turn)) in
                    {"command", "prompt", "replaceNote"}, "unknown turn type")
            if "command" in turn:
                require(isinstance(turn["command"], str) and
                        re.fullmatch(r"/(?:mode (?:general|study|research)|study [^\r\n]+)", turn["command"]), "unsupported command")
            if "prompt" in turn:
                require(isinstance(turn["prompt"], str) and bool(turn["prompt"].strip()), "prompt must contain text")
            if "replaceNote" in turn:
                change = turn["replaceNote"]
                require(isinstance(change, dict) and set(change) == {"path", "text"} and
                        isinstance(change["text"], str), "replaceNote needs path and text")
                note_path(change["path"])
    return suite


class Rpc:
    def __init__(self, args, env, cwd, timeout):
        self.timeout, self.serial, self.events = timeout, 0, []
        self.q = queue.Queue()
        self.process = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        def read():
            for line in self.process.stdout:
                try:
                    self.q.put(json.loads(line))
                except json.JSONDecodeError:
                    continue
            self.q.put(None)
        threading.Thread(target=read, daemon=True).start()

    def send(self, value):
        self.process.stdin.write(json.dumps(value, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def request(self, kind, *, wait_turn=False, **fields):
        self.serial += 1
        identity = str(self.serial)
        self.send({"id": identity, "type": kind, **fields})
        deadline, response = time.monotonic() + self.timeout, None
        accepted, started, settled = False, False, False
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Pi request timed out")
            try:
                event = self.q.get(timeout=remaining)
            except queue.Empty as error:
                raise TimeoutError("Pi request timed out") from error
            if event is None:
                raise RuntimeError("Pi exited before completing the request")
            self.events.append(event)
            if not isinstance(event, dict):
                raise RuntimeError("Pi returned a malformed RPC event")
            if event.get("type") == "extension_error":
                raise RuntimeError(f"Pi extension failed: {event.get('error', 'unknown extension error')}")
            message = event.get("message")
            if event.get("type") == "message_end" and isinstance(message, dict) and \
                    message.get("role") == "assistant" and message.get("stopReason") in {"error", "aborted"}:
                raise RuntimeError(f"Pi model {message['stopReason']}: {message.get('errorMessage') or 'model turn did not complete'}")
            if event.get("type") in {"message_start", "message_end"} and isinstance(message, dict) and \
                    message.get("role") == "custom" and message.get("customType") == "pi-mode-error":
                content = message.get("content", "")
                if isinstance(content, list):
                    content = "\n".join(str(c.get("text", "")) for c in content if isinstance(c, dict) and c.get("type") == "text")
                try:
                    detail = json.loads(content).get("error", content)
                except (ValueError, TypeError, AttributeError):
                    detail = str(content)
                raise RuntimeError(f"Pi mode command failed: {detail}")
            if event.get("type") == "extension_ui_request" and event.get("method") in {"confirm", "select", "input", "editor"}:
                # Evaluation never grants new permissions or answers its own questions.
                self.send({"type": "extension_ui_response", "id": event["id"], "cancelled": True})
            if event.get("type") == "response" and event.get("id") == identity:
                if not event.get("success"):
                    raise RuntimeError(event.get("error", "RPC request failed"))
                response = event.get("data")
                accepted = True
                if not wait_turn:
                    return response
            if event.get("type") == "agent_start":
                started, settled = True, False
            if event.get("type") == "agent_settled" and started:
                settled = True
            # agent_end can precede retry, compaction, and extension continuation.
            # A matching successful response and this run's settled event are both required.
            if wait_turn and accepted and settled:
                return response

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", default=str(Path(__file__).with_name("tasks.json")))
    parser.add_argument("--validate", action="store_true", help="Validate fixtures without starting Pi or calling a model")
    parser.add_argument("--provider")
    parser.add_argument("--model")
    parser.add_argument("--label", default="candidate")
    parser.add_argument("--case", action="append", dest="cases")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--workstation-host", default="tuf-fedora")
    parser.add_argument("--output", default=str(Path(__file__).with_name("results")))
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    suite = load_suite(args.suite)
    if args.validate:
        print(f"Validated {len(suite['cases'])} synthetic cases on {socket.gethostname()}; no model calls.")
        return
    if socket.gethostname() != args.workstation_host:
        parser.error("Model evaluations must run on Workstation; use ssh ws. --validate is allowed anywhere.")
    if not args.provider or not args.model:
        parser.error("Choose --provider and --model explicitly; no paid model is selected automatically.")
    if not shutil.which("pi"):
        parser.error("Pi is not installed on this Workstation. Set up its runtime and model login before evaluation.")
    cases = [c for c in suite["cases"] if not args.cases or c["id"] in args.cases]
    if not cases or args.cases and set(args.cases) - {c["id"] for c in cases}:
        parser.error("Unknown or empty case selection")
    output = Path(args.output) / dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    output.mkdir(parents=True, mode=0o700)
    root = Path(__file__).resolve().parents[1]
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    for case in cases:
        with tempfile.TemporaryDirectory(prefix="pi-quality-") as temp:
            vault = Path(temp) / "vault"
            vault.mkdir()
            for name, text in suite["notes"].items():
                target = vault / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text)
            env = {**os.environ, "PI_STUDY_VAULT": str(vault)}
            rpc = Rpc(["pi", "--mode", "rpc", "--no-context-files", "--no-skills", "--no-extensions", "--no-builtin-tools", "--provider", args.provider,
                       "--model", args.model, "--session-dir", str(Path(temp) / "sessions"),
                       "-e", str(root / "extensions/study/index.ts")], env, str(vault), args.timeout)
            started = time.monotonic()
            result = {"case": case["id"], "label": args.label, "commit": commit,
                      "host": socket.gethostname(), "provider": args.provider, "model": args.model,
                      "criteria": [{"criterion": c, "rating": None, "evidence": None} for c in case["criteria"]],
                      "reviewStatus": "unreviewed", "error": None}
            try:
                for turn in case["turns"]:
                    if "replaceNote" in turn:
                        change = turn["replaceNote"]
                        target = vault / change["path"]
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_text(change["text"])
                    else:
                        rpc.request("prompt", message=turn.get("prompt", turn.get("command")), wait_turn="prompt" in turn)
                result["messages"] = rpc.request("get_messages")
                result["sessionStats"] = rpc.request("get_session_stats")
            except Exception as error:
                result["error"] = str(error)
            finally:
                result["elapsedSeconds"] = time.monotonic() - started
                rpc.close()
            # Only this synthetic task's transcript is saved. Credential stores are never copied.
            result["events"] = rpc.events
            target = output / f"{case['id']}.json"
            target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
            target.chmod(0o600)
            print(f"{case['id']}: {'ERROR' if result['error'] else 'captured; needs review'} -> {target}")
            if result["error"]:
                raise SystemExit(1)


if __name__ == "__main__":
    main()
