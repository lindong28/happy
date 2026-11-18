import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async importOriginal => {
    const original = await importOriginal<typeof import('node:child_process')>();
    return { ...original, execFileSync: (command: string, args: string[], options: any) =>
        command === 'ps' ? (args.includes('tty=') ? 'null\n' : 'owner-start\n') : original.execFileSync(command, args, options) };
});
import { registerNativeTerminal, nativeTitleState, readNativeTitleState } from './nativeTerminal';

let directory: string | undefined;
afterEach(async () => { vi.unstubAllEnvs(); if(directory) await rm(directory,{recursive:true,force:true}); directory=undefined; });
async function root() {
    directory=await mkdtemp(join(tmpdir(),'ht-')); await chmod(directory,0o700);
    await writeFile(join(directory,'ready.json'),JSON.stringify({threadId:'thread'}),{mode:0o600});
    vi.stubEnv('TERM_PROGRAM','ghostty'); return directory;
}
it('is optional and registers independent foreground ownership only when enabled',async()=>{
    const dir=await root(); vi.stubEnv('HAPPY_NATIVE_TITLE_HOOK','');
    expect(await registerNativeTerminal(dir,'thread')).toBeNull();
    const hook=join(dir,'hook'); await writeFile(hook,'#!/bin/sh\ncat >/dev/null\n',{mode:0o700});
    vi.stubEnv('HAPPY_NATIVE_TITLE_HOOK',hook);
    const first=await registerNativeTerminal(dir,'thread'); const second=await registerNativeTerminal(dir,'thread');
    expect(first).not.toBeNull(); expect(second).not.toBeNull();
    const row=JSON.parse(await readFile(first!.file,'utf8'));
    expect(row).toMatchObject({schema_version:1,thread_id:'thread',owner_pid:process.pid,owner_started_at:'owner-start',tty:'/dev/null'});
    expect(await readdir(join(dir,'terminal-bindings'))).toHaveLength(4);
    await first!.close(); await first!.close();
    expect(JSON.parse(await readFile(second!.file,'utf8')).thread_id).toBe('thread');
    await second!.close(); expect(await readdir(join(dir,'terminal-bindings'))).toEqual([]);
});
it('never registers into an insecure native directory',async()=>{
    const dir=await root(); vi.stubEnv('HAPPY_NATIVE_TITLE_HOOK','/fixture/hook'); await chmod(dir,0o755);
    await expect(registerNativeTerminal(dir,'thread')).rejects.toThrow();
});
it('maps active, input-waiting and idle statuses without inventing idle for unknown status',()=>{
    expect(nativeTitleState({type:'active',activeFlags:[]})).toBe('busy');
    expect(nativeTitleState({type:'active',activeFlags:['waitingOnUserInput']})).toBe('idle');
    expect(nativeTitleState({type:'active',activeFlags:['waitingOnApproval']})).toBe('idle');
    expect(nativeTitleState({type:'idle'})).toBe('idle');
    expect(nativeTitleState({type:'notLoaded'})).toBeNull();
    expect(nativeTitleState(null)).toBeNull();
});
it('initial synchronization only initializes and reads the existing socket; closing it keeps the server alive',async()=>{
    const dir=await root(); const socket=join(dir,'f.sock'); const http=createServer(); const server=new WebSocketServer({server:http});
    const methods:string[]=[];
    server.on('connection',client=>client.on('message',data=>{
        const message=JSON.parse(data.toString()); methods.push(message.method);
        if(message.id!==undefined) client.send(JSON.stringify({id:message.id,result:message.method==='thread/read'?{thread:{id:'thread',status:{type:'active',activeFlags:[]}}}:{}}));
    }));
    await new Promise<void>(resolve=>http.listen(socket,resolve));
    try {
        expect(await readNativeTitleState(socket,'thread')).toBe('busy');
        expect(methods).toEqual(['initialize','initialized','thread/read']);
        expect(http.listening).toBe(true);
    } finally {for(const c of server.clients)c.terminate();server.close();await new Promise<void>(resolve=>http.close(()=>resolve()));}
});
