import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeLoader, makeApi, makeCtx, fire, test, assert, assertIncludes, report } from "./harness.mjs";
const temp=mkdtempSync(join(tmpdir(),"pi-study-memory-")),vault=join(temp,"vault");mkdirSync(vault);
const original="# NAT 與 Reverse Shell\nNAT 保存轉譯對應。\n回連需要可到達的監聽端。\n";
writeFileSync(join(vault,"NAT.md"),original);process.env.PI_STUDY_VAULT=vault;
const j=await makeLoader(),m=await j.import(resolve("extensions/study/memory.ts")),n=await j.import(resolve("extensions/study/notes.ts"));
const {boundedContext,default:factory}=await j.import(resolve("extensions/study/index.ts"));
const citation={path:"NAT.md",sha256:n.fingerprint(original),startLine:2,endLine:3,quote:"NAT 保存轉譯對應。"};
const concept={kind:"concept",topic:"reverse-shell",title:"NAT 與回連",body:"回連需要可到達的監聽端。",sources:[citation]};
const boot=()=>{const api=makeApi();factory(api);return{api,ctx:makeCtx()};};
async function rejects(fn,needle){let error;try{await fn();}catch(e){error=e;}assert(error,"expected rejection");if(needle)assertIncludes(error.message,needle);}
try{
await test("保存不可變版本與 Markdown 索引，原始筆記不變",()=>{
  m.verifyCitations(vault,[citation]);m.saveRecord(vault,{...concept,status:"source-derived"});
  assert(m.records(vault).length===1);assert(readFileSync(join(vault,"NAT.md"),"utf8")===original);
  assertIncludes(readFileSync(join(vault,"07-Agent-Wiki/index.md"),"utf8"),"concepts/reverse-shell");
  assertIncludes(readFileSync(join(vault,"07-Agent-Wiki/schema.md"),"utf8"),"不是能力認證");
  assert(!readFileSync(join(vault,"07-Agent-Wiki/concepts/reverse-shell.md"),"utf8").includes("學習觀察：source-derived"));
});
await test("拒絕錯引文、假 hash、錯行號",async()=>{
  await rejects(()=>m.verifyCitations(vault,[{...citation,quote:"捏造的引文"}]),"引文");
  await rejects(()=>m.verifyCitations(vault,[{...citation,sha256:"bad"}]),"變更");
  await rejects(()=>m.verifyCitations(vault,[{...citation,endLine:99}]),"行號");
});
await test("未讀來源不能編 wiki；更新需正確舊版本",async()=>{
  const{api,ctx}=boot(),tool=api._tools.get("study_wiki"),args={topic:"nat-basics",title:"NAT",body:"概念整理",sources:[citation]};
  await rejects(()=>tool.execute("t",args,undefined,undefined,ctx),"尚未讀取");
  await api._tools.get("study_read").execute("t",{path:"NAT.md"},undefined,undefined,ctx);
  const saved=JSON.parse((await tool.execute("t",args,undefined,undefined,ctx)).content[0].text);
  assert(saved.kind==="concept"&&saved.status==="source-derived"&&saved.path==="07-Agent-Wiki/concepts/nat-basics.md");
  assert(!("body" in saved)&&!("sources" in saved),"保存收據不應重送正文或引文");
  const recalled=JSON.parse((await api._tools.get("study_memory").execute("t",{id:saved.id},undefined,undefined,ctx)).content[0].text).records[0];
  assert(recalled.body===args.body&&JSON.stringify(recalled.sources)===JSON.stringify(args.sources));
  assertIncludes(readFileSync(join(vault,saved.path),"utf8"),args.body);
  await rejects(()=>tool.execute("t",args,undefined,undefined,ctx),"版本已改變");
  const revision=JSON.parse((await tool.execute("t",{...args,supersedes:saved.id,body:"加入前提條件"},undefined,undefined,ctx)).content[0].text);
  assert(revision.supersedes===saved.id&&revision.id!==saved.id);
  assert(m.visibleRecords(m.records(vault)).filter(r=>r.topic==="nat-basics").length===1);
});
await test("ID 可回讀被更新的概念與研究，撤回後停止回傳且不影響目前版本",async()=>{
  const{api,ctx}=boot(),memory=api._tools.get("study_memory");
  const recall=async(params)=>JSON.parse((await memory.execute("t",params,undefined,undefined,ctx)).content[0].text);
  for(const kind of ["concept","research"]){
    const topic=`history-${kind}`,path=`History-${kind}.md`,sourceText="原始來源。",newText="更新來源。";
    writeFileSync(join(vault,path),sourceText);
    const source={path,sha256:n.fingerprint(sourceText),startLine:1,endLine:1,quote:sourceText};
    const data={kind,topic,title:"版本回讀",body:"第一版完整內容",sources:[source],status:kind==="concept"?"source-derived":"draft"};
    const first=m.saveRecord(vault,data);
    writeFileSync(join(vault,path),newText);
    const latest=m.saveRecord(vault,{...data,body:"第二版目前結論",sources:[{...source,sha256:n.fingerprint(newText),quote:newText}],supersedes:first.id});
    const previous=await recall({id:first.id}),current=await recall({id:latest.id});
    assert(previous.records.length===1&&JSON.stringify(previous.records[0])===JSON.stringify(first),"ID 回讀需保留原始紀錄全文");
    assert(previous.recordStates[0].id===first.id&&!previous.recordStates[0].isCurrent&&previous.recordStates[0].historical);
    assert(!("historical" in previous.records[0])&&!("isCurrent" in previous.records[0]),"版本狀態不可修改原始紀錄");
    assert(current.recordStates[0].isCurrent&&!current.recordStates[0].historical&&current.records[0].body===latest.body);
    assert(previous.recordStates[0].freshness[0].status==="changed"&&current.recordStates[0].freshness[0].status==="current","來源狀態必須逐一檢查讀取版本");
    const listing=await recall({topic}),defaults=await recall({});
    assert(listing.records.length===1&&listing.records[0].id===latest.id);
    assert(!defaults.records.some(r=>r.id===first.id)&&defaults.records.some(r=>r.id===latest.id));
    await api._commands.get("wiki").handler(`forget ${first.id}`,ctx);
    const forgotten=await recall({id:first.id}),remaining=await recall({id:latest.id});
    assert(forgotten.records.length===0&&forgotten.total===0&&forgotten.recordStates.length===0);
    assert(remaining.records[0].id===latest.id&&remaining.recordStates[0].isCurrent);
    const retraction=m.records(vault).find(r=>r.kind==="retraction"&&r.target===first.id);
    assert(retraction&&(await recall({id:retraction.id})).records.length===0,"不回傳撤回操作紀錄");
    assert(m.records(vault).some(r=>r.id===first.id),"撤回只停止回傳，不刪除歷史");
  }
});
await test("來源修改會標記 changed，不悄悄當最新",()=>{
  writeFileSync(join(vault,"NAT.md"),original+"新觀察\n");
  assert(m.lintWiki(vault).issues.some(i=>i.issue.includes("changed")));
  assert(m.memoryContext(vault,"NAT").some(r=>r.freshness.some(s=>s.status==="changed")));
  writeFileSync(join(vault,"NAT.md"),original);
});
await test("學習觀察驗證使用者原話，拒絕助手和假證據，重試去重",async()=>{
  const{api,ctx}=boot(),quote="即使靶機主動連線，我這邊的監聽端也必須可以被到達。";
  await api._commands.get("mode").handler("study",ctx);
  ctx.sessionManager.getBranch=()=>[
    {type:"message",id:"a1",message:{role:"assistant",content:[{type:"text",text:"助手說的話不能當作使用者理解。"}]}},
    {type:"message",id:"u1",message:{role:"user",content:[{type:"text",text:quote}]}}
  ];
  const params={topic:"reverse-shell",title:"回連可達性",question:"回連一定成功嗎？",evidence:quote,messageId:"current",status:"partial",reasoning:"已指出可達性前提，尚未判斷路由。",nextQuestion:"如何判斷路由問題？"};
  const tool=api._tools.get("study_observe");
  await rejects(()=>tool.execute("t",{...params,evidence:"助手說的話不能當作使用者理解。",messageId:"a1"},undefined,undefined,ctx),"證據");
  await rejects(()=>tool.execute("t",{...params,evidence:"使用者沒有說過這一句回答"},undefined,undefined,ctx),"證據");
  const receipt=JSON.parse((await tool.execute("t",params,undefined,undefined,ctx)).content[0].text);
  const retry=JSON.parse((await tool.execute("t",params,undefined,undefined,ctx)).content[0].text);
  assert(retry.id===receipt.id&&receipt.kind==="learning"&&receipt.path===`07-Agent-Wiki/learning/${receipt.id}.md`);
  assert(!("body" in receipt)&&!("evidence" in receipt)&&!("question" in receipt),"保存收據不應重送理解證據");
  const recalled=JSON.parse((await api._tools.get("study_memory").execute("t",{id:receipt.id},undefined,undefined,ctx)).content[0].text).records[0];
  assert(recalled.body===params.reasoning&&recalled.evidence===quote&&recalled.question===params.question&&recalled.nextQuestion===params.nextQuestion);
  const saved=m.records(vault).filter(r=>r.kind==="learning");assert(saved.length===1&&saved[0].messageId==="u1");
});
await test("新 extension/session 會自動讀到相關學習紀錄",async()=>{
  const{api,ctx}=boot();await api._commands.get("study").handler("NAT",ctx);
  const r=await fire(api,"before_agent_start",{prompt:"回連問題",systemPrompt:""},ctx),data=JSON.parse(r.message.content);
  assert(data.memory.some(r=>r.kind==="learning"&&r.status==="partial"));assert(data.recentUserMessages.at(-1).messageId==="current");
});
await test("停用後檢索不再顯示，歷史仍可追溯",()=>{
  const r=m.records(vault).find(r=>r.kind==="learning");m.saveRecord(vault,{kind:"retraction",topic:r.topic,title:"停用",body:"使用者要求",target:r.id});
  assert(!m.visibleRecords(m.records(vault)).some(x=>x.id===r.id));assert(m.records(vault).some(x=>x.id===r.id));
});
await test("並行更新標衝突，不用時間戳擅自覆蓋",()=>{
  const first=m.records(vault).find(r=>r.topic==="reverse-shell"&&r.kind==="concept"),a=m.saveRecord(vault,{...concept,supersedes:first.id,body:"分支 A"});
  const b={...a,id:"12345678-1234-1234-1234-123456789abc",body:"分支 B"};
  writeFileSync(join(vault,"07-Agent-Wiki/.records",`${b.id}.json`),JSON.stringify(b));
  assert(m.lintWiki(vault).issues.some(i=>i.issue==="並行版本衝突"));assert(m.memoryContext(vault,"NAT").some(r=>r.conflict));
});
await test("context 大小受限且保留最新回答",()=>{
  const value={current:{content:"x".repeat(10000)},related:[{content:"x".repeat(20000)}],memory:[{body:"x".repeat(10000)}],recentUserMessages:[{text:"old"},{text:"new"}]};
  const text=boundedContext(value);assert(text.length<=26000);assert(JSON.parse(text).recentUserMessages.at(-1).text==="new");
});
await test("記憶片段標示截斷，可依 ID 取回完整正文與證據",async()=>{
  const{api,ctx}=boot(),body="可達性分析與限制。".repeat(300),evidence="我需要確認雙向路由和防火牆。".repeat(100);
  const saved=m.saveRecord(vault,{kind:"learning",topic:"memory-recall",title:"記憶片段回讀",body,evidence,status:"partial",sessionId:"recall-session",messageId:"recall-answer"});
  const fragment=m.memoryContext(vault,"memory-recall",20).find(r=>r.id===saved.id);
  assert(fragment&&fragment.truncated&&fragment.bodyTruncated&&fragment.evidenceTruncated);
  assert(fragment.body.length<body.length&&fragment.evidence.length<evidence.length);
  assert(fragment.readMore.tool==="study_memory"&&fragment.readMore.id===saved.id);
  const recalled=JSON.parse((await api._tools.get(fragment.readMore.tool).execute("t",{id:fragment.readMore.id},undefined,undefined,ctx)).content[0].text).records[0];
  assert(recalled.body===body&&recalled.evidence===evidence,"完整證據必須保留在紀錄中");
  for(const [topic,bodyLength,evidenceLength] of [["body-only",2201,1200],["evidence-only",2200,1201],["complete-memory",2200,1200]]){
    const record=m.saveRecord(vault,{kind:"learning",topic,title:topic,body:"字".repeat(bodyLength),evidence:"字".repeat(evidenceLength),sessionId:"boundary-session",messageId:topic});
    const item=m.memoryContext(vault,topic,20).find(r=>r.id===record.id);
    assert(item.bodyTruncated===(topic==="body-only")&&item.evidenceTruncated===(topic==="evidence-only"));
    assert(item.truncated===(topic!=="complete-memory")&&!!item.readMore===(topic!=="complete-memory"));
  }
});
await test("中文找英文概念，修改和新增筆記會刷新索引",()=>{
  assert(n.searchNotes(n.listNotes(vault),"為什麼反向連線還會失敗")[0]?.path==="NAT.md");
  writeFileSync(join(vault,"DNS.md"),"# DNS\nDNSSEC validates signed records.");assert(n.searchNotes(n.listNotes(vault),"DNSSEC")[0]?.path==="DNS.md");
  writeFileSync(join(vault,"DNS.md"),"# DNS\n只有解析名稱。");assert(!n.searchNotes(n.listNotes(vault),"DNSSEC").length);
});
}finally{rmSync(temp,{recursive:true,force:true});}report();
