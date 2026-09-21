import './isolate.mjs';
import { resolve } from "node:path";
import { makeLoader, test, assert, assertIncludes, report } from "./harness.mjs";
const j=await makeLoader(),w=await j.import(resolve("extensions/study/web.ts"));
await test("拒絕本機、私網、mapped IPv6 與非網頁協定",()=>{
  for(const url of ["http://127.0.0.1","http://169.254.169.254","http://[::1]","http://[::ffff:127.0.0.1]","file:///etc/passwd","https://user:pass@example.com","http://example.com:8080"]){let failed=false;try{w.publicURL(url);}catch{failed=true;}assert(failed,url);}
  assert(w.publicAddress("1.1.1.1"));assert(!w.publicAddress("10.0.0.1"));
});
await test("RSS 只回公開網頁，摘要不冒充正文",()=>{
  const xml='<rss><channel><item><title>Official</title><link>https://example.com/doc</link><description>Summary</description></item><item><link>http://127.0.0.1/</link></item></channel></rss>';
  const r=w.parseRSS(xml);assert(r.length===1&&r[0].snippet==="Summary");
});
await test("搜尋回登入或驗證頁時明確失敗",()=>{let failed=false;try{w.parseRSS('<html>captcha required</html>');}catch{failed=true;}assert(failed);});
await test("正文保留段落、移除 script 和導覽，不執行網頁",()=>{
  const r=w.extractPage('<html><title>Doc</title><nav>Menu</nav><main><h1>Protocol</h1><p>Explanation</p><script>steal()</script><pre>example command</pre></main></html>',"text/html");
  assert(r.title==="Doc");assertIncludes(r.text,"Explanation");assertIncludes(r.text,"example command");assert(!r.text.includes("steal")&&!r.text.includes("Menu"));
});
await test("大正文標為截斷",()=>{const r=w.extractPage("a".repeat(70000),"text/plain");assert(r.truncated&&r.text.length===60000);});
report();
