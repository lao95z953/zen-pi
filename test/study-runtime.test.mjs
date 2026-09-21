import './isolate.mjs';
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, assert, report } from "./harness.mjs";

const temp=mkdtempSync(join(tmpdir(),"pi-study-runtime-")),vault=join(temp,"vault"),agent=join(temp,"agent");
mkdirSync(vault);mkdirSync(agent);
writeFileSync(join(vault,"NAT.md"),"# NAT 與 Reverse Shell\nNAT 保存轉譯對應。\n回連需要可到達的監聽端。\n");
const evidence="即使靶機主動連線，監聽端也必須可以被到達。";
let phase=1,calls=0,capturedMemory=[],toolErrors=[],serverError,researchContext;
const server=createServer(async(req,res)=>{
  try{
    let body="";for await(const chunk of req)body+=chunk;
    const request=JSON.parse(body);calls++;
    const contexts=request.messages.flatMap(message=>{
      const text=typeof message.content==="string"?message.content:message.content?.filter(c=>c.type==="text").map(c=>c.text).join("\n");
      try{const parsed=JSON.parse(text);return parsed.current!==undefined&&parsed.focus?[parsed]:[];}catch{return[];}
    });
    const context=contexts.at(-1);assert(context,"Pi 必須送出筆記 context");
    for(const message of request.messages.filter(m=>m.role==="tool")){
      if(/Error:|證據必須|尚未讀取|版本已改變/.test(JSON.stringify(message.content)))toolErrors.push(message.content);
    }
    let delta,finish;
    if(phase===1&&calls===1){
      assert(context.current.path==="NAT.md");
      assert(context.recentUserMessages.at(-1).text===evidence);
      const note=context.current;
      delta={role:"assistant",tool_calls:[
        {index:0,id:"call_observe",type:"function",function:{name:"study_observe",arguments:JSON.stringify({topic:"reverse-shell",title:"回連可達性",question:"回連一定成功嗎？",evidence,messageId:"current",status:"partial",reasoning:"能指出可達性前提，還需驗證路由判斷。",nextQuestion:"如何確認監聽端可達？"})}},
        {index:1,id:"call_wiki",type:"function",function:{name:"study_wiki",arguments:JSON.stringify({topic:"reverse-shell",title:"NAT 與回連",body:"回連仍需要可達的監聽端。",sources:[{path:note.path,sha256:note.sha256,startLine:2,endLine:3,quote:"NAT 保存轉譯對應。"}]})}}
      ]};finish="tool_calls";
    }else if(phase===3&&calls===1){
      assert(context.mode==="research");
      const note=context.current||context.related.find(n=>n.path==="NAT.md");assert(note,"研究需讀到來源");
      delta={role:"assistant",tool_calls:[{index:0,id:"call_research",type:"function",function:{name:"research_save",arguments:JSON.stringify({topic:"nat-research",title:"NAT 研究測試",question:"NAT 與回連的前提",scope:"測試來源整理，不代表真實論文回顧",status:"synthesis",findings:[{claim:"NAT 保存轉譯對應。",type:"source",sourceIndices:[1]}],sources:[{path:note.path,sha256:note.sha256,startLine:2,endLine:2,quote:"NAT 保存轉譯對應。"}],uncertainties:["尚未驗證網路配置。"],nextSteps:["查閱協議文件。"],draft:{type:"experiment-report",sections:[{heading:"實驗設計",text:"尚未執行，沒有實驗結果。",sourceIndices:[]}]}})}}]};finish="tool_calls";
    }else{
      if(phase===2)capturedMemory=context.memory;
      if(phase===4)researchContext=context;
      delta={role:"assistant",content:"測試完成"};finish="stop";
    }
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    const emit=(d,f)=>res.write(`data: ${JSON.stringify({id:"mock-completion",object:"chat.completion.chunk",created:1,model:"study-mock",choices:[{index:0,delta:d,finish_reason:f}]})}\n\n`);
    emit(delta,null);emit({},finish);res.end("data: [DONE]\n\n");
  }catch(err){serverError=err;res.writeHead(500);res.end(JSON.stringify({error:{message:err.message}}));}
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const port=server.address().port;
writeFileSync(join(agent,"settings.json"),JSON.stringify({packages:[resolve(".")],defaultProvider:"mock",defaultModel:"study-mock"}));
writeFileSync(join(agent,"models.json"),JSON.stringify({providers:{mock:{baseUrl:`http://127.0.0.1:${port}/v1`,api:"openai-completions",apiKey:"test-placeholder",compat:{supportsDeveloperRole:false,supportsReasoningEffort:false},models:[{id:"study-mock",reasoning:false,input:["text"],contextWindow:64000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));

function runPi(message,kickoff="/study NAT"){return new Promise((resolveRun,reject)=>{
  const child=spawn("pi",["--mode","rpc","--no-session","--no-context-files","--no-skills"],{cwd:vault,env:{...process.env,PI_CODING_AGENT_DIR:agent,PI_STUDY_VAULT:vault,PI_LLM_WIKI:join(vault,"07-Agent-Wiki")},stdio:["pipe","pipe","pipe"]});
  let buffer="",stderr="",finished=false;
  const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("Pi mock provider timed out: "+stderr.slice(0,800)));},25000);
  child.stderr.on("data",chunk=>stderr+=chunk);
  child.stdout.on("data",chunk=>{
    buffer+=chunk;let end;
    while((end=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let data;try{data=JSON.parse(line);}catch{continue;}
      if(data.type==="response"&&!data.success){clearTimeout(timer);child.kill();reject(new Error(JSON.stringify(data)));return;}
      if(data.id==="select"&&message!==undefined)child.stdin.write(JSON.stringify({id:"ask",type:"prompt",message})+"\n");
      if(data.type==="agent_end"){finished=true;child.stdin.end();}
    }
  });
  child.on("error",reject);child.on("close",code=>{clearTimeout(timer);if(finished&&code===0)resolveRun();else reject(new Error(`Pi exited ${code}: ${stderr.slice(0,800)}`));});
  child.stdin.write(JSON.stringify({id:"select",type:"prompt",message:kickoff})+"\n");
});}
try{
  await test("真正 Pi + 本機假 provider：讀筆記→工具寫 Wiki/理解紀錄→新對話讀回",async()=>{
    await runPi(evidence);if(serverError)throw serverError;
    assert(toolErrors.length===0,JSON.stringify(toolErrors));
    const dir=join(vault,"07-Agent-Wiki/.records"),saved=readdirSync(dir).filter(f=>f.endsWith(".json")).map(f=>JSON.parse(readFileSync(join(dir,f),"utf8")));
    assert(saved.some(r=>r.kind==="learning"&&r.evidence===evidence));assert(saved.some(r=>r.kind==="concept"));
    phase=2;await runPi("請根據之前的回連理解繼續教我。");if(serverError)throw serverError;
    assert(capturedMemory.some(r=>r.kind==="learning"&&r.status==="partial"));
  });
  await test("真正 Pi：/research 啟動工具保存，另一 Session resume 讀回研究與草稿",async()=>{
    phase=3;calls=0;await runPi(undefined,"/research NAT 與回連的前提");if(serverError)throw serverError;
    assert(toolErrors.length===0,JSON.stringify(toolErrors));
    assert(readFileSync(join(vault,"07-Agent-Wiki/research/nat-research.md"),"utf8").includes("尚未執行"));
    phase=4;await runPi(undefined,"/research resume nat-research");if(serverError)throw serverError;
    assert(researchContext.mode==="research"&&researchContext.research.checkpoint.length===1);
    assert(researchContext.memory.some(r=>r.kind==="research"));
  });
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(temp,{recursive:true,force:true});}
report();
