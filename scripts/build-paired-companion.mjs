import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import crypto from 'node:crypto'
import {gzipSync} from 'node:zlib'
const root=fileURLToPath(new URL('..',import.meta.url)),source=path.resolve(process.argv[2]??'')
if(!process.argv[2])throw new Error('请指定独立账号插件源码目录')
const manifest=JSON.parse(await fs.readFile(path.join(source,'extension.json'),'utf8')),pkg=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8'))
if(manifest.id!=='ofm.account-connectors'||pkg.name!=='dsh-ofm-account-connectors'||pkg.version!==manifest.version)throw new Error('独立插件身份不符')
const files=[]
for(const name of [...new Set([...Object.keys(manifest.files),'extension.json','package.json','README.md'])].sort()){
 if(!name.split('/').every(p=>p&&p!=='.'&&p!=='..')||name.includes('\\')||name.includes(':'))throw new Error('路径错误')
 const file=path.join(source,name);if(!(await fs.lstat(file)).isFile())throw new Error('载荷必须是普通文件')
 const bytes=await fs.readFile(file),sha256=crypto.createHash('sha256').update(bytes).digest('hex')
 if(manifest.files[name]&&manifest.files[name]!==sha256)throw new Error('源插件清单与字节不一致：'+name)
 files.push({path:name,size:bytes.length,sha256,base64:bytes.toString('base64')})
}
const payload={format:'ofm-paired-plugin/v1',name:pkg.name,version:pkg.version,files},bytes=gzipSync(Buffer.from(JSON.stringify(payload)),{level:9})
if(bytes.length>4*1024*1024)throw new Error('配套载荷超过旧版更新器单文件4MiB限制')
await fs.mkdir(path.join(root,'companions'),{recursive:true});await fs.writeFile(path.join(root,'companions/account-connectors.json.gz'),bytes)
console.log(JSON.stringify({files:files.length,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}))
