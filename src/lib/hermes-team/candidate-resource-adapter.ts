import { z } from 'zod';
import { toolHash } from '@/lib/mcp/snapshot';
import type { McpToolDef } from '@/lib/mcp/kinds';
import type { VerifiedTeamToolAdapter } from './tool-policy';

/** Candidate scope contract: only MCP tools whose actual resource argument is resourceId, with optional text content. */
export const parseCandidateResourceInput=(action:string)=>(input:unknown)=>{
  const value=z.object({resourceId:z.string().min(1).max(200),content:z.string().max(48000).optional()}).strict().parse(input);
  return {action,resourceIds:[value.resourceId],arguments:value};
};
export const candidateResourceAdapterId=(tool:McpToolDef)=>`collective-mcp-resource-v1:${toolHash(tool)}`;
/** This constructs an unregistered candidate. Only separately tested, expiring evidence may enter the verified registry. */
export function candidateResourceAdapter(capabilityId:string,tool:McpToolDef,effect:'read'|'write',evidence:VerifiedTeamToolAdapter['evidence']):VerifiedTeamToolAdapter{
  return {id:candidateResourceAdapterId(tool),capabilityId,action:tool.name,effect,evidence,parseInput:parseCandidateResourceInput(tool.name)};
}
