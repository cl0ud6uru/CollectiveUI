import { describe, expect, it, vi } from 'vitest';
import { DashboardClient } from '@/lib/remote-hermes/client';

describe('native paged browsing and history projections', () => {
  it('uses bounded native paging, no inline images, and display-only message fields', async () => {
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => Response.json({ messages: [
      { id: 1, role: 'user', content: 'Original internal text', display_content: 'User-visible text', active: 0, compacted: 1, token: 'private', env: { secret: 'private' } },
      { id: 2, role: 'assistant', content: 'Hidden scaffold', display_kind: 'hidden' },
      { id: 3, role: 'assistant', content: 'Answer' },
    ], pagination: { limit: 200, offset: 200, order: 'latest', returned: 3 } }));
    const result = await new DashboardClient('https://example.com/hermes', fetcher).history('default', 'stored/id', 200);
    expect(String(fetcher.mock.calls[0][0])).toContain('/api/sessions/stored%2Fid/messages?');
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({profile:'default',limit:'200',offset:'200',order:'latest',include_compacted:'true',inline_images:'false'});
    expect(result).toEqual({ messages: [{id:'1',role:'user',text:'User-visible text'},{id:'3',role:'assistant',text:'Answer'}],nextOffset:203,hasMore:false });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('rejects dot-segment identities before contacting a dashboard', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const id of ['.', '..', '']) await expect(new DashboardClient('https://example.com', fetcher).history('default', id, 0)).rejects.toThrow('identity');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('retains native multimodal text and attachment markers without exposing payloads', async () => {
    const client = new DashboardClient('https://example.com', async () => Response.json({
      messages: [
        {id:10,role:'user',content:[{type:'text',text:'Describe this image'},{type:'image_url',image_url:{url:'data:image/png;base64,private-image-bytes'}},{type:'input_text',text:'Extra prompt'},{type:'input_audio',input_audio:{data:'private-audio-bytes'}},{type:'secret',value:'private-value'}]},
        {id:11,role:'user',display_content:[{type:'input_image',image_url:'https://private.example/image'}]},
        {id:12,role:'assistant',display_kind:'hidden',content:[{type:'output_text',text:'Hidden scaffold'}]},
      ],pagination:{limit:200,offset:0,order:'latest',returned:3},
    }));
    const result = await client.history('default','chat',0);
    expect(result).toEqual({messages:[{id:'10',role:'user',text:'Describe this image\n[image]\nExtra prompt\n[audio]'},{id:'11',role:'user',text:'[image]'}],nextOffset:3,hasMore:false});
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('Hidden scaffold');
  });
  it('advances offsets by raw rows even when hidden rows have no display representation', async () => {
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => Response.json({messages:Array.from({length:200}, (_,id)=>({id,role:'assistant',content:'hidden',display_kind:'hidden'})),pagination:{limit:200,offset:400,order:'latest',returned:200}}));
    expect(await new DashboardClient('https://example.com',fetcher).history('default','chat',400)).toEqual({messages:[],nextOffset:600,hasMore:true});
  });
  it('fails closed when the dashboard cannot prove the requested latest history page', async () => {
    for (const pagination of [undefined, null, {}, {limit:200,offset:200}, {limit:200,offset:200,order:'oldest'}, {limit:200,offset:0,order:'latest'}, {limit:500,offset:200,order:'latest'}]) {
      const client = new DashboardClient('https://example.com', async () => Response.json({messages:[{id:1,role:'assistant',content:'Unproven page'}],pagination}));
      await expect(client.history('default','chat',200)).rejects.toThrow('does not support paged conversation history');
    }
  });
  it('can discover sessions outside the first page without projecting native metadata', async () => {
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => Response.json({sessions:[{id:'old',title:'Old chat',system_prompt:'private'}]}));
    expect(await new DashboardClient('https://example.com',fetcher).sessions('default',100)).toEqual([{id:'old',title:'Old chat'}]);
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('offset')).toBe('100');
  });
  it('pages by the native window and total, independently of appended pinned chats', async () => {
    const fetcher = vi.fn<typeof fetch>(async input => {
      const offset = Number(new URL(String(input)).searchParams.get('offset'));
      const page = Array.from({ length: Math.min(100, Math.max(0, 201 - offset)) }, (_, i) => ({ id: `chat-${offset + i}` }));
      // Mirrors pinned Hermes list_sessions_rich(include_pinned=True): all pins
      // absent from the SQL page are appended without consuming its offset.
      if (!page.some(s => s.id === 'chat-200')) page.push({ id: 'chat-200' });
      return Response.json({ sessions: page, total: 201, limit: 100, offset });
    });
    const client = new DashboardClient('https://example.com', fetcher);
    const first = await client.sessionPage('default', 0);
    expect(first.sessions).toHaveLength(101); expect(first.nextOffset).toBe(100); expect(first.hasMore).toBe(true);
    const second = await client.sessionPage('default', first.nextOffset);
    expect(second.sessions).toHaveLength(101); expect(second.sessions[0].id).toBe('chat-100'); expect(second.nextOffset).toBe(200); expect(second.hasMore).toBe(true);
    const last = await client.sessionPage('default', second.nextOffset);
    expect(last.sessions.map(s => s.id)).toEqual(['chat-200']); expect(last.hasMore).toBe(false);
  });
  it('keeps bounded pin backfill selectable but fails closed when pagination metadata is absent', async () => {
    const client = new DashboardClient('https://example.com', async () => Response.json({ sessions: Array.from({ length: 101 }, (_, i) => ({ id: String(i) })) }));
    expect(await client.sessions('default')).toHaveLength(101);
    await expect(client.sessionPage('default')).rejects.toThrow('does not support paged');
    const oversized = new DashboardClient('https://example.com', async () => Response.json({ sessions: Array.from({ length: 2001 }, (_, i) => ({ id: String(i) })), total: 2001 }));
    await expect(oversized.sessionPage('default')).rejects.toThrow();
  });
});
