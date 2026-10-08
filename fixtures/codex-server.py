#!/usr/bin/env python3
"""Deterministic app-server fixture; never calls a model or executes requested commands."""
import json
import sys

with open('scenario.json') as f:
    scenario = json.load(f)
log = open('requests.jsonl', 'a', buffering=1)

def read():
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    message = json.loads(line)
    log.write(json.dumps(message) + '\n')
    if message.get('method') == 'turn/interrupt' and not scenario.get('ignoreInterrupt'):
        reply(message, {})
        event('turn/completed', {'turn': {'id': 'turn-1', 'status': 'interrupted'}})
        sys.exit(0)
    return message

def send(message):
    print(json.dumps(message), flush=True)

def reply(message, result):
    send({'id': message['id'], 'result': result})

def event(method, params):
    send({'method': method, 'params': dict(threadId='thread-1', turnId='turn-1', **params)})

while True:
    message = read()
    method = message.get('method')
    if method == 'initialize':
        if scenario.get('hangInit'):
            # Wait without responding, but exit on closed stdin even through a Windows launcher.
            while True:
                read()
        reply(message, {'userAgent': 'mock'})
    elif method == 'initialized':
        pass
    elif method == 'config/read':
        reply(message, {'config': scenario.get('config', {'sandbox_mode': 'read-only', 'approval_policy': 'on-request', 'approvals_reviewer': 'user'})})
    elif method == 'configRequirements/read':
        reply(message, {'requirements': scenario.get('requirements')})
    elif method in ('thread/start', 'thread/resume'):
        if method == 'thread/resume' and scenario.get('resumeError'):
            send({'id': message['id'], 'error': {'code': -32000, 'message': scenario['resumeError']}})
        else:
            reply(message, {'thread': {'id': 'thread-1'}})
    elif method == 'turn/start':
        if scenario.get('exitEarly'):
            sys.exit(1)
        if scenario.get('malformed'):
            print('not-json', flush=True)
        event('item/agentMessage/delta', {'itemId': 'text-1', 'delta': 'Hello '})
        # Deliberately send notifications before the turn/start response.
        event('item/agentMessage/delta', {'itemId': 'text-1', 'delta': 'world'})
        reply(message, {'turn': {'id': 'turn-1'}})
        send({'method': 'item/agentMessage/delta', 'params': {'threadId': 'other', 'turnId': 'other', 'itemId': 'x', 'delta': 'IGNORE'}})
        event('item/completed', {'item': {'id': 'text-1', 'type': 'agentMessage', 'text': 'Hello world'}})
        event('thread/tokenUsage/updated', {'tokenUsage': {'last': {'totalTokens': 250}, 'modelContextWindow': 128000}})
        if scenario.get('autoReview'):
            event('item/autoApprovalReview/started', {'reviewId': 'review-1', 'review': {'status': 'inProgress'}})
            event('item/autoApprovalReview/completed', {'reviewId': 'review-1', 'review': {'status': 'approved', 'rationale': 'Read reference'}})
        requests = scenario.get('approvals', [])
        for index, request in enumerate(requests):
            params = dict(threadId='thread-1', turnId='turn-1', itemId='tool-' + str(index), reason='Need access')
            params.update(request.get('params', {}))
            send({'id': request.get('id', 90 + index), 'method': request.get('method', 'item/commandExecution/requestApproval'), 'params': params})
        if scenario.get('resolve'):
            for index, request in enumerate(requests):
                event('serverRequest/resolved', {'requestId': request.get('id', 90 + index)})
        else:
            for _ in requests:
                read()
        if scenario.get('hold'):
            while True:
                read()
        event('turn/completed', {'turn': {'id': 'turn-1', 'status': scenario.get('status', 'completed'), 'error': {'message': 'Generation failed'}}})
