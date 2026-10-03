"""Isolated NDJSON protocol fixture; never loads Hermes, credentials, MCP or a provider."""
import json
import os
import pathlib
import sys
import subprocess
import time

home = pathlib.Path(os.environ['HERMES_HOME'])
sessions_file = home / 'fixture-sessions.json'
sessions = json.loads(sessions_file.read_text()) if sessions_file.exists() else {}
live = {}
pending = {}
def send(v):
    print(json.dumps(dict(jsonrpc='2.0', **v)), flush=True)
def event(sid, kind, payload):
    send(dict(method='event', params=dict(type=kind, session_id=sid, payload=payload)))
def complete(sid, text='Fixture answer', status='complete'):
    event(sid, 'message.complete', dict(text=text, status=status, usage=dict(input=12, output=3, model='fixture-model')))
def reply(rid, **v):
    send(dict(id=rid, result=v))
send(dict(method='event', params=dict(type='gateway.ready', payload={})))
for line in sys.stdin:
    f = json.loads(line)
    method = f.get('method')
    p = f.get('params', {})
    rid = f.get('id')
    sid = p.get('session_id')
    if method == 'ping':
        reply(rid, pong=True)
    elif method == 'client.capabilities':
        reply(rid, server_requests=['approval', 'clarify'])
    elif method == 'gateway.capabilities':
        reply(rid, per_session_exclusive_submit=True)
    elif method == 'session.create':
        stored = 'stored-' + str(len(sessions) + 1)
        sid = 'runtime-' + stored
        sessions[stored] = True
        # The fixture must survive termination during create, as native transactional storage does.
        temp_sessions = sessions_file.with_suffix('.tmp')
        temp_sessions.write_text(json.dumps(sessions))
        temp_sessions.replace(sessions_file)
        live[sid] = stored
        reply(rid, session_id=sid, stored_session_id=stored, info=dict(desktop_contract=8, model='fixture-model'))
    elif method == 'session.resume':
        if sid not in sessions:
            send(dict(id=rid, error=dict(code=4008, message='No such session')))
        else:
            stored = sid
            sid = 'resumed-' + stored
            live[sid] = stored
            reply(rid, session_id=sid, session_key=stored, status='idle', running=False, info=dict(desktop_contract=8, stored_session_id=stored))
    elif method == 'session.usage':
        reply(rid, input=2, output=1)
    elif method == 'prompt.submit':
        text = p.get('text', '')
        with (home / 'fixture-prompts.jsonl').open('a') as log:
            log.write(json.dumps(dict(session=sid, text=text)) + '\n')
        reply(rid, status='streaming')
        if text == 'approve':
            event(sid, 'tool.start', dict(tool_id='native-tool', name='terminal', args=dict(command='echo approved')))
            pending['srq-1'] = sid
            send(dict(id='srq-1', method='approval', params=dict(session_id=sid, command='echo approved', description='Fixture approval', request_id='native-request', choices=['once', 'deny'])))
        elif text == 'unsupported':
            send(dict(id='srq-unsupported', method='secret', params=dict(session_id=sid)))
        elif text == 'slow':
            pass
        elif text in ('descendant', 'orphan'):
            child = subprocess.Popen([sys.executable, '-c', 'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(300)'])
            (home / 'fixture-group').write_text(str(os.getpgrp()))
            time.sleep(0.1)
            event(sid, 'message.delta', dict(text='child ready'))
            if text == 'orphan':
                os._exit(0)
        elif text == 'malformed':
            print('not-json', flush=True)
        elif text == 'oversized':
            print('x' * (2 * 1024 * 1024 + 1), flush=True)
        elif text == 'environment':
            event(sid, 'message.delta', dict(text=json.dumps(sorted(os.environ))))
            complete(sid, 'environment checked')
        else:
            event(sid, 'message.delta', dict(text='Fixture '))
            event(sid, 'message.delta', dict(text='answer'))
            complete(sid)
    elif method == 'session.interrupt':
        reply(rid, interrupted=True)
        # Deliberately no completion: native deferred cancellation may emit only an error.
        event(sid, 'error', dict(message='Turn cancelled before agent ready'))
    elif method is None and rid in pending:
        sid = pending.pop(rid)
        choice = f.get('result', {}).get('choice', 'unsupported')
        with (home / 'fixture-approvals.jsonl').open('a') as log:
            log.write(json.dumps(dict(id=rid, choice=choice)) + '\n')
        event(sid, 'request.cancel', dict(id=rid, method='approval', reason='resolved'))
        event(sid, 'tool.complete', dict(tool_id='native-tool', name='terminal', result=dict(output=choice)))
        complete(sid, 'Tool ' + choice)
    elif method:
        send(dict(id=rid, error=dict(code=-32601, message='Unknown fixture method')))
