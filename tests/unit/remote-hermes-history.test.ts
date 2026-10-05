import { describe, expect, it, vi } from 'vitest';
import { DashboardClient } from '@/lib/remote-hermes/client';

describe('native paged browsing and history projections', () => {
  it('uses bounded native paging, no inline images, and display-only message fields', async () => {
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => Response.json({ messages: [
      { id: 1, role: 'user', content: 'Original internal text', display_content: 'User-visible text', token: 'private', env: { secret: 'private' } },
      { id: 2, role: 'assistant', content: 'Hidden scaffold', display_kind: 'hidden' },
      { id: 3, role: 'assistant', content: 'Answer' },
    ] }));
    const result = await new DashboardClient('https://example.com/hermes', fetcher).history('default', 'stored/id', 200);
    expect(String(fetcher.mock.calls[0][0])).toContain('/api/sessions/stored%2Fid/messages?');
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({profile:'default',limit:'200',offset:'200',order:'latest',inline_images:'false'});
    expect(result).toEqual({ messages: [{id:'1',role:'user',text:'User-visible text'},{id:'3',role:'assistant',text:'Answer'}],nextOffset:203,hasMore:false });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('rejects dot-segment identities before contacting a dashboard', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const id of ['.', '..', '']) await expect(new DashboardClient('https://example.com', fetcher).history('default', id, 0)).rejects.toThrow('identity');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('advances offsets by raw rows even when hidden rows have no display representation', async () => {
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => Response.json({messages:Array.from({length:200}, (_,id)=>({id,role:'assistant',content:'hidden',display_kind:'hidden'}))}));
    expect(await new DashboardClient('https://example.com',fetcher).history('default','chat',400)).toEqual({messages:[],nextOffset:600,hasMore:true});
  });
  it('can discover sessions outside the first page without projecting native metadata', async () => {
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => Response.json({sessions:[{id:'old',title:'Old chat',system_prompt:'private'}]}));
    expect(await new DashboardClient('https://example.com',fetcher).sessions('default',100)).toEqual([{id:'old',title:'Old chat'}]);
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('offset')).toBe('100');
  });
});
