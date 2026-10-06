import {beforeEach,expect,it,vi} from "vitest";
const f=vi.hoisted(()=>({read:vi.fn(),answer:vi.fn(),principal:vi.fn(async()=>({user:{id:"owner"}}))}));
vi.mock("@/lib/session",()=>({requirePrincipal:f.principal,errorResponse:(e:{status?:number;message:string})=>Response.json({error:e.message},{status:e.status??500})}));
vi.mock("@/lib/delegation/approvals",()=>({pendingTaskApprovals:f.read,answerTaskApproval:f.answer}));
import {GET,POST} from "@/app/api/chat/[id]/approvals/route";
const ctx={params:Promise.resolve({id:"origin"})};
const input={runId:"child",approvalId:"opaque-signed-id",approved:true};
const request=(body:unknown=input,headers:Record<string,string>={origin:"https://portal.test"})=>new Request("https://portal.test/api/chat/origin/approvals",{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();f.read.mockResolvedValue([]);f.answer.mockResolvedValue({accepted:true});});
it("serves uncached owner-scoped requests and accepts only decision fields",async()=>{
 const response=await GET(new Request("https://portal.test"),ctx);expect(response.headers.get("cache-control")).toBe("private, no-store");expect(f.read).toHaveBeenCalledWith({user:{id:"owner"}},"origin");
 expect((await POST(request(),ctx)).status).toBe(200);expect(f.answer).toHaveBeenCalledWith({user:{id:"owner"}},"origin",input);
});
it("rejects cross-origin cookie mutations and extra tool/input fields",async()=>{
 expect((await POST(request(input,{origin:"https://foreign.test"}),ctx)).status).toBe(403);
 expect((await POST(request({...input,input:{command:"modified"}}),ctx)).status).toBe(400);expect(f.answer).not.toHaveBeenCalled();
});
it("supports authenticated native bearer clients without a browser Origin",async()=>{
 expect((await POST(request(input,{authorization:"Bearer synthetic-native-token"}),ctx)).status).toBe(200);
});
it("treats malformed JSON as invalid input",async()=>{
 const request=new Request("https://portal.test/api/chat/origin/approvals",{method:"POST",headers:{origin:"https://portal.test"},body:"{"});expect((await POST(request,ctx)).status).toBe(400);expect(f.answer).not.toHaveBeenCalled();
});
