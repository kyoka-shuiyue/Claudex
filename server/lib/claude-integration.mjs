// 只准备差异；安装函数只能在用户明确同意后调用。保留现有设置，写入前检查并备份。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const digest=text=>crypto.createHash('sha256').update(text).digest('hex');
export function integrationPreview({claudeHome,root,node=process.execPath}) {
  const file=path.join(claudeHome,'settings.json');
  let text='{}';
  if(fs.existsSync(file)) {
    const stat=fs.lstatSync(file);
    if(stat.isSymbolicLink() || stat.nlink>1)throw new Error('Claude 设置是共享链接，需先核对其来源');
    text=fs.readFileSync(file,'utf8');
  }
  const settings=JSON.parse(text.replace(/^\uFEFF/,''));
  const command=`"${path.resolve(node)}" "${path.join(path.resolve(root),'server','claude-hook.mjs')}"`;
  const canonical=value=>{const result=path.resolve(value);return process.platform==='win32'?result.toLowerCase():result;};
  const sameCommand=value=>{
    const parts=/^"([^"]+)"\s+"([^"]+)"\s*$/.exec(value||'');
    return parts && canonical(parts[1])===canonical(node) && canonical(parts[2])===canonical(path.join(root,'server','claude-hook.mjs'));
  };
  const hooks=settings.hooks?.SessionStart || [];
  const alreadyInstalled=hooks.some(entry=>entry.hooks?.some(hook=>sameCommand(hook.command)));
  return {file,command,expectedHash:digest(text),alreadyInstalled,existingCount:hooks.length};
}

export function installIntegration({claudeHome,root,node=process.execPath,expectedHash,backupDirectory}) {
  const preview=integrationPreview({claudeHome,root,node});
  if(preview.expectedHash!==expectedHash)throw new Error('Claude 设置刚刚发生变化，请刷新后再安装接入');
  if(preview.alreadyInstalled)return {...preview,changed:false};
  const original=fs.existsSync(preview.file)?fs.readFileSync(preview.file,'utf8'):'{}';
  const settings=JSON.parse(original.replace(/^\uFEFF/,''));
  settings.hooks ||= {};
  settings.hooks.SessionStart ||= [];
  settings.hooks.SessionStart.push({matcher:'startup|resume',hooks:[{type:'command',command:preview.command,timeout:5}]});
  fs.mkdirSync(backupDirectory,{recursive:true,mode:0o700});
  const backup=path.join(backupDirectory,`claude-settings-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(backup,original,{mode:0o600,flag:'wx'});
  const temp=path.join(claudeHome,`.claudex-settings-${crypto.randomBytes(8).toString('hex')}.tmp`);
  fs.writeFileSync(temp,JSON.stringify(settings,null,2)+'\n',{mode:0o600,flag:'wx'});
  // 防止准备与写入之间别的应用更新设置。
  if(integrationPreview({claudeHome,root,node}).expectedHash!==expectedHash){fs.unlinkSync(temp);throw new Error('Claude 设置刚刚发生变化，已保留原文件');}
  fs.renameSync(temp,preview.file);
  return {file:preview.file,command:preview.command,changed:true,backup};
}
