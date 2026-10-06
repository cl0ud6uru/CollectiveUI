import { describe,expect,it } from 'vitest';
import { validateNativeModelRequest } from '@/lib/hermes-team/native-request';
const body={model:'synthetic-model',messages:[{role:'user',content:'Title this session'}],response_format:{type:'json_schema',json_schema:{name:'session_title',strict:true,schema:{type:'object',properties:{title:{type:'string'}},required:['title'],additionalProperties:false}}},reasoning:{enabled:false}};
describe('Pinned native auxiliary title request',()=>{
 it('normalizes the exact disabled reasoning hint and bounds its omitted token cap',()=>{const normalized=validateNativeModelRequest(body,'chat_completions',body.model);expect(normalized).toEqual({...body,reasoning:undefined,max_tokens:256});expect(normalized).not.toHaveProperty('reasoning');});
 it('rejects arbitrary reasoning and alternate output override fields',()=>{for(const reasoning of [{enabled:true},{enabled:false,max_tokens:1000000},{effort:'high'}])expect(()=>validateNativeModelRequest({...body,reasoning},'chat_completions',body.model)).toThrow();});
});
