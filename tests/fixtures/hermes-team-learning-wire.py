"""Synthetic NDJSON learning controller fixture; no Hermes, model, credentials or tools."""
import json
import pathlib
import os
import sys

home = pathlib.Path(os.environ['HERMES_HOME'])
session = 'runtime-learning'
def reply(rid, **value):
    print(json.dumps({'jsonrpc':'2.0','id':rid,'result':value}), flush=True)
print(json.dumps({'jsonrpc':'2.0','method':'event','params':{'type':'gateway.ready','payload':{}}}), flush=True)
for line in sys.stdin:
    frame = json.loads(line)
    method, rid, params = frame.get('method'), frame.get('id'), frame.get('params', {})
    if method == 'ping':
        reply(rid, pong=True)
    elif method == 'gateway.capabilities':
        reply(rid, per_session_exclusive_submit=True)
    elif method == 'client.capabilities':
        reply(rid, server_requests=['approval','clarify','secret','sudo','vault.unlock_prompt','vault.save_login','vault.code'])
    elif method in ('session.create','session.resume'):
        reply(rid, session_id=session, stored_session_id='stored-learning', info={'desktop_contract':8})
    elif method == 'session.usage':
        reply(rid, input=0, output=0)
    elif method == 'collective.learning.run':
        with (home / 'learning-wire.jsonl').open('a') as log:
            log.write(json.dumps(params) + '\n')
        reply(rid, finished=set(params)=={'session_id'} and params['session_id']==session)
    elif method == 'collective.session.settled':
        reply(rid, session_id=session, settled=True)
    else:
        print(json.dumps({'jsonrpc':'2.0','id':rid,'error':{'code':4000,'message':'Unexpected synthetic learning method'}}), flush=True)
