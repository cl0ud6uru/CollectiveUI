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
queued = {}
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
        reply(rid, server_requests=['approval', 'clarify', 'secret', 'sudo', 'vault.unlock_prompt', 'vault.save_login', 'vault.code'])
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
    elif method == 'collective.session.settled':
        reply(rid, session_id=sid, settled=sid in live and not pending and not queued)
    elif method == 'session.activate':
        if queued.get(sid) == 'Race fixture queue' and not pending:
            queued.pop(sid)
            event(sid, 'message.start', {})
            pending['srq-input'] = (sid, 'protected')
            send(dict(id='srq-input', method='secret', params=dict(session_id=sid, prompt='Enter synthetic protected value')))
        if sid not in live:
            send(dict(id=rid, error=dict(code=4008, message='No such session')))
        else:
            reply(rid, session_id=sid, running=bool(pending), info=dict(model='fixture-model', provider='fixture', usage=dict(input=12, output=3, context_used=200, context_max=1000, context_percent=20)))
    elif method in ('image.attach_bytes', 'pdf.attach', 'file.attach'):
        with (home / 'fixture-attachments.jsonl').open('a') as log:
            log.write(json.dumps(dict(method=method, name=p.get('filename') or p.get('name'), content=p.get('content_base64') or p.get('data_url'))) + '\n')
        if p.get('filename') == 'slow.png':
            time.sleep(0.25)
        reply(rid, attached=True, ref_text='@fixture.txt' if method == 'file.attach' else '', path='fixture-image' if method == 'image.attach_bytes' else '')
    elif method == 'session.steer':
        with (home / 'fixture-controls.jsonl').open('a') as log:
            log.write(json.dumps(dict(method=method, text=p.get('text'))) + '\n')
        if p.get('text') == 'followup correction':
            queued[sid] = p.get('text')
        reply(rid, status='rejected' if p.get('text') == 'rejected correction' else 'queued')
    elif method == 'session.usage':
        reply(rid, input=2, output=1)
    elif method == 'prompt.submit' and p.get('queued'):
        with (home / 'fixture-controls.jsonl').open('a') as log:
            log.write(json.dumps(dict(method=method, text=p.get('text'), queued=True)) + '\n')
        queued[sid] = p.get('text', '')
        reply(rid, status='queued')
    elif method == 'prompt.submit':
        text = p.get('text', '')
        with (home / 'fixture-prompts.jsonl').open('a') as log:
            log.write(json.dumps(dict(session=sid, text=text)) + '\n')
        reply(rid, status='streaming')
        if text == 'approve':
            event(sid, 'tool.start', dict(tool_id='native-tool', name='terminal', args=dict(command='echo approved')))
            pending['srq-1'] = sid
            send(dict(id='srq-1', method='approval', params=dict(session_id=sid, command='echo approved', description='Fixture approval', request_id='native-request', choices=['once', 'deny'])))
        elif text in ('clarify', 'single', 'protected'):
            pending['srq-input'] = (sid, text)
            params = dict(session_id=sid)
            if text == 'clarify':
                params['questions'] = [dict(qid='q-one', question='Which fixture?', choices=['One', 'Two'])]
            elif text == 'single':
                params.update(question='Which single fixture?', choices=['One', 'Two'])
            else:
                params.update(prompt='Enter synthetic protected value', env_var='FIXTURE_KEY')
            send(dict(id='srq-input', method='clarify' if text in ('clarify', 'single') else 'secret', params=params))
        elif text == 'unsupported':
            send(dict(id='srq-unsupported', method='window.read', params=dict(session_id=sid)))
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
        item = pending.pop(rid)
        if isinstance(item, tuple):
            sid, kind = item
            result = f.get('result', {})
            valid = (result.get('answers') == {'q-one': 'One'} if kind == 'clarify' else result.get('answer') == 'One' if kind == 'single' else result.get('value') == 'synthetic-protected')
            event(sid, 'request.cancel', dict(id=rid, method='clarify' if kind in ('clarify', 'single') else 'secret', reason='resolved'))
            complete(sid, 'Native input accepted' if valid else 'Native input skipped')
            continue
        sid = item
        choice = f.get('result', {}).get('choice', 'unsupported')
        with (home / 'fixture-approvals.jsonl').open('a') as log:
            log.write(json.dumps(dict(id=rid, choice=choice)) + '\n')
        event(sid, 'request.cancel', dict(id=rid, method='approval', reason='resolved'))
        event(sid, 'tool.complete', dict(tool_id='native-tool', name='terminal', result=dict(output=choice)))
        complete(sid, 'Tool ' + choice)
        if sid in queued:
            queued.pop(sid)
            event(sid, 'message.start', {})
            pending['srq-input'] = (sid, 'protected')
            send(dict(id='srq-input', method='secret', params=dict(session_id=sid, prompt='Enter synthetic protected value')))
    elif method:
        send(dict(id=rid, error=dict(code=-32601, message='Unknown fixture method')))
