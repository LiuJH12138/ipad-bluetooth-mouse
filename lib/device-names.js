'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {randomUUID} = require('node:crypto');

// One file per local USB identifier lets separate console processes rename
// different devices without replacing a shared inventory.
class DeviceNames {
  constructor(directory = path.join(process.env.LOCALAPPDATA || os.homedir(), 'iPadControlConsole', 'device-names')) {
    this.directory = directory;
  }
  get(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) return '';
    try { return fs.readFileSync(path.join(this.directory,id),'utf8'); }
    catch { return ''; }
  }
  set(id, name) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || typeof name !== 'string' ||
        name.length > 32 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name))
      throw Object.assign(new Error('请输入最多 32 个字符的单行设备别名。'),{status:400});
    const alias = name.trim();
    const target = path.join(this.directory,id);
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
      if (!alias) fs.rmSync(target,{force:true});
      else {
        fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
        fs.writeFileSync(temporary,alias,{flag:'wx',mode:0o600});
        fs.renameSync(temporary,target);
      }
    } catch {
      try { fs.rmSync(temporary,{force:true}); } catch {}
      throw Object.assign(new Error('无法保存设备别名，请检查本机用户目录的写入权限。'),{status:500});
    }
    return alias;
  }
}
module.exports = {DeviceNames};
