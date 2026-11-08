import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { integrationPreview,installIntegration } from '../lib/claude-integration.mjs';
import { tmpDir } from './fixtures.mjs';

test('接入只添加自己的 SessionStart hook，保留现有设置、备份且重复安装不增加',()=>{
 const claudeHome=tmpDir('hook-settings'),root=tmpDir('hook-root'),backupDirectory=tmpDir('hook-backup');
 const original={env:{ANTHROPIC_BASE_URL:'https://example.invalid',ANTHROPIC_AUTH_TOKEN:'secret-test'},hooks:{SessionStart:[{hooks:[{type:'command',command:'existing hook'}]}]},permissions:{defaultMode:'default'}};
 const text=JSON.stringify(original);fs.writeFileSync(path.join(claudeHome,'settings.json'),text);
 const preview=integrationPreview({claudeHome,root});
 assert.equal(fs.readFileSync(preview.file,'utf8'),text,'准备差异不写用户设置');
 assert.ok(!JSON.stringify(preview).includes('secret-test'));
 const installed=installIntegration({claudeHome,root,expectedHash:preview.expectedHash,backupDirectory});
 assert.equal(fs.readFileSync(installed.backup,'utf8'),text);
 const settings=JSON.parse(fs.readFileSync(preview.file,'utf8'));
 assert.deepEqual(settings.env,original.env);assert.deepEqual(settings.permissions,original.permissions);
 assert.equal(settings.hooks.SessionStart.length,2);
 assert.deepEqual(settings.hooks.SessionStart[0],original.hooks.SessionStart[0]);
 const latest=integrationPreview({claudeHome,root});
 assert.equal(installIntegration({claudeHome,root,expectedHash:latest.expectedHash,backupDirectory}).changed,false);
});

test('用户同时修改设置时拒绝覆盖，损坏或链接文件也不写入',()=>{
 const claudeHome=tmpDir('hook-race'),root=tmpDir('hook-root'),backupDirectory=tmpDir('hook-backup');
 const file=path.join(claudeHome,'settings.json');fs.writeFileSync(file,'{}');
 const preview=integrationPreview({claudeHome,root});
 fs.writeFileSync(file,'{"changed":true}');
 assert.throws(()=>installIntegration({claudeHome,root,expectedHash:preview.expectedHash,backupDirectory}),/变化/);
 assert.equal(fs.readFileSync(file,'utf8'),'{"changed":true}');
 fs.writeFileSync(file,'broken');assert.throws(()=>integrationPreview({claudeHome,root}));
 const hardlink=path.join(claudeHome,'shared.json');fs.linkSync(file,hardlink);
 assert.throws(()=>integrationPreview({claudeHome,root}),/共享链接/);
});
