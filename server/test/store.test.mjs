import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStore,DEFAULT_CONFIG} from '../lib/store.mjs';
import {tmpDir} from './fixtures.mjs';
test('不同运行目录的队列和嵌套配置互相隔离，不共享默认对象',()=>{
 const first=createStore(tmpDir('store-first')),second=createStore(tmpDir('store-second'));
 first.state.sends.isolated={status:'failed'};
 first.config.codex.extraArgs.push('test-only');
 assert.equal(second.state.sends.isolated,undefined);
 assert.deepEqual(second.config.codex.extraArgs,[]);
 assert.deepEqual(DEFAULT_CONFIG.codex.extraArgs,[]);
});
