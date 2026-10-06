"""Startup registration stub only. Fixture entry supplies its synthetic wire replies.

This deliberately has no native worker/session ledger. Calling the installed real
settlement observer directly must fail closed; ledger behavior is tested separately
with explicit stub modules in gateway-settlement.test.ts.
"""
_methods = {}

def _turn_isolation_enabled():
    return False

def _ok(rid, result):
    return {'jsonrpc': '2.0', 'id': rid, 'result': result}


def _err(rid, code, message):
    return {'jsonrpc': '2.0', 'id': rid, 'error': {'code': code, 'message': message}}
