import { spawn } from 'node:child_process';

const children=[
  spawn(process.execPath,['server/index.js'],{stdio:'inherit',env:{...process.env,NODE_ENV:process.env.NODE_ENV||'development'}}),
  spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1'],{stdio:'inherit',env:process.env}),
];
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');setTimeout(()=>process.exit(code),300).unref()}
for(const child of children)child.on('exit',(code)=>{if(!stopping&&code!==0)stop(code||1)});
process.on('SIGINT',()=>stop(0));process.on('SIGTERM',()=>stop(0));
