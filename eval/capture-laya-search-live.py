"""Capture public search pages with Zen's own DOM observer in headless Firefox.

Run on the Workstation with Selenium installed. Output is JSONL for browser-laya.mjs.
No personal browser profile, screenshot, cookie export, or model call is used.
"""
import json
import sys
from copy import deepcopy
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.firefox.options import Options


def main():
    if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != "train"):
        raise SystemExit("Usage: python eval/capture-laya-search-live.py OUTPUT_JSONL [train]")
    source = Path("browser/addon/content.js").read_text(encoding="utf-8")
    observer = "let observation = null;" + source.split("let observation = null;", 1)[1].split("browser.runtime.onMessage.addListener", 1)[0] + "return observe();"
    holdout = [
        ("wikipedia-home", "https://www.wikipedia.org/", "Search Wikipedia for Alan Turing and view the results.", "fill"),
        ("wikipedia-results", "https://en.wikipedia.org/w/index.php?search=Alan+Turing+computing", "Search Wikipedia for Alan Turing computing and view the results.", "DONE"),
        ("wikipedia-article", "https://en.wikipedia.org/wiki/Alan_Turing", "Search Wikipedia for Alan Turing and open the Alan Turing article.", "DONE"),
        ("duckduckgo-home", "https://duckduckgo.com/", "Search DuckDuckGo for climate records and view the results.", "fill"),
        ("duckduckgo-results", "https://duckduckgo.com/?q=climate+records", "Search DuckDuckGo for climate records and view the results.", "DONE"),
        ("mojeek-home", "https://www.mojeek.com/", "Search Mojeek for bird migration and view the results.", "fill"),
        ("google-home-zh", "https://www.google.com/", "在 Google 搜尋氣候紀錄，查看搜尋結果。", "fill"),
        ("yahoo-home", "https://search.yahoo.com/", "Search Yahoo for climate records and view the results.", "fill"),
        ("yahoo-results", "https://search.yahoo.com/search?p=climate+records", "Search Yahoo for climate records and view the results.", "DONE"),
    ]
    train = [
        ("gutenberg-home", "https://www.gutenberg.org/", "Search Project Gutenberg for astronomy and view the results.", "fill", "Go!", "astronomy"),
        ("gutenberg-results", "https://www.gutenberg.org/ebooks/search/?query=astronomy", "Search Project Gutenberg for astronomy and view the results.", "DONE", None, None),
        ("python-home", "https://www.python.org/", "Search Python.org for typing and view the results.", "fill", "GO", "typing"),
        ("wiktionary-home", "https://www.wiktionary.org/", "Search Wiktionary for algorithm and view the results.", "fill", "Search", "algorithm"),
        ("wiktionary-article", "https://en.wiktionary.org/wiki/algorithm", "Search Wiktionary for algorithm and open the algorithm article.", "DONE", None, None),
        ("bing-home", "https://www.bing.com/", "Search Bing for climate records and view the results.", "fill", None, None),
        ("bing-results", "https://www.bing.com/search?q=climate+records", "Search Bing for climate records and view the results.", "DONE", None, None),
        ("brave-home", "https://search.brave.com/", "Search Brave for graph algorithms and view the results.", "fill", None, None),
        ("ecosia-home", "https://www.ecosia.org/", "Search Ecosia for bird migration and view the results.", "fill", None, None),
        ("arxiv-results", "https://arxiv.org/search/?query=machine+learning&searchtype=all", "Search arXiv for machine learning and view the results.", "DONE", None, None),
        ("openlibrary-home", "https://openlibrary.org/", "Search Open Library for astronomy and view the results.", "click:Search", None, None),
        ("openlibrary-results", "https://openlibrary.org/search?q=astronomy", "Search Open Library for astronomy and view the results.", "DONE", None, None),
        ("pypi-home", "https://pypi.org/", "Search PyPI for Django and view the results.", "fill", "Search", "Django"),
        ("npm-home", "https://www.npmjs.com/", "Search npm for React and view the results.", "fill", "Search", "React"),
        ("npm-results", "https://www.npmjs.com/search?q=react", "Search npm for React and view the results.", "DONE", None, None),
        ("python-docs-results", "https://docs.python.org/3/search.html?q=typing", "Search Python documentation for typing and view the results.", "DONE", None, None),
    ]
    cases = train if len(sys.argv) == 3 else holdout
    done_evidence = {
        "wikipedia-results": "Alan Turing computing", "wikipedia-article": "Alan Turing",
        "duckduckgo-results": "climate records", "yahoo-results": "climate records",
        "gutenberg-results": "astronomy", "wiktionary-article": "algorithm",
        "bing-results": "climate records", "arxiv-results": "machine learning",
        "openlibrary-results": "astronomy", "npm-results": "react", "python-docs-results": "typing",
    }
    options = Options()
    options.add_argument("-headless")
    driver = webdriver.Firefox(options=options)
    rows = []
    try:
        driver.set_page_load_timeout(30)
        for case in cases:
            name, url, goal, expected_kind = case[:4]
            driver.get(url)
            page = driver.execute_script(observer)
            if expected_kind == "DONE":
                visible_text = (page["title"] + " " + page["text"]).lower()
                evidence = done_evidence[name]
                if evidence.lower() not in visible_text or any(word in page["title"].lower() for word in ("captcha", "challenge", "just a moment", "verification")):
                    raise ValueError(f"{name}: requested result is not visibly present")
            if expected_kind == "fill":
                matches = [a for a in page["actions"] if a["kind"] == "fill" and ("search" in a["label"].lower() or "搜尋" in a["label"])]
                if len(matches) != 1:
                    raise ValueError(f"{name}: expected one visible search field, got {[(a['id'], a['label']) for a in matches]}")
                expected = matches[0]["id"]
            elif expected_kind.startswith("click:"):
                matches = [a for a in page["actions"] if a["kind"] == "click" and a["label"] == expected_kind[6:]]
                if len(matches) != 1:
                    raise ValueError(f"{name}: expected one click target, got {[(a['id'], a['label']) for a in matches]}")
                expected = matches[0]["id"]
            else:
                expected = expected_kind
            rows.append({"name": name, "page": page, "goal": goal, "expected": expected})
            print(json.dumps({"name": name, "title": page["title"], "url": page["url"],
                              "actions": len(page["actions"]), "expected": expected,
                              "first_actions": [(a["id"], a["label"]) for a in page["actions"][:8]]}, ensure_ascii=False), flush=True)
            if len(case) == 6 and case[4]:
                submit = [a for a in page["actions"] if a["kind"] == "click" and a["label"] == case[4]]
                if len(submit) != 1:
                    raise ValueError(f"{name}: expected one visible submit button, got {[(a['id'], a['label']) for a in submit]}")
                filled = deepcopy(page)
                field = next(a for a in filled["actions"] if a["id"] == expected)
                field["value"] = case[5]
                rows.append({"name": name.replace("-home", "-filled"), "page": filled, "goal": goal,
                             "expected": submit[0]["id"], "history": [f"fill {field['label']}"]})
    finally:
        driver.quit()
    output = Path(sys.argv[1])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


if __name__ == "__main__":
    main()
