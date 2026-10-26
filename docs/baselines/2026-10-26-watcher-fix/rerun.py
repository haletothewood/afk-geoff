from pathlib import Path
import subprocess,os,json,time,shutil
r=Path('/private/tmp/afk-watcher-rerun-2026-10-26');r.mkdir(exist_ok=True)
source=Path('/Users/david/Documents/ChatGPT/afk-geoff');old=Path('/private/tmp/afk-baseline-2026-10-26')
node='/Users/david/.nvm/versions/node/v24.14.1/bin/node';npm='/Users/david/.nvm/versions/node/v24.14.1/lib/node_modules/npm/bin/npm-cli.js'
env=os.environ.copy();env['PATH']=str(old/'tools/node_modules/.bin')+':/Users/david/.nvm/versions/node/v24.14.1/bin:'+env['PATH']
def call(args,cwd,label):
 start=time.monotonic();p=subprocess.run(args,cwd=cwd,env=env,capture_output=True,text=True,timeout=120)
 (r/(label+'.stdout')).write_text(p.stdout);(r/(label+'.stderr')).write_text(p.stderr)
 print(label,p.returncode,p.stdout[:500],p.stderr[:300],flush=True)
 if p.returncode: raise RuntimeError(label)
 return p
p=call([node,npm,'pack','--ignore-scripts','--json','--pack-destination',str(r)],source/'packages/cli','pack')
tarball=r/json.loads(p.stdout)[0]['filename']
call([node,npm,'install','--prefix',str(r/'install'),str(tarball),'--no-audit','--no-fund'],r,'install')
repo=r/'repo';repo.mkdir(exist_ok=True)
call(['git','init','-b','main'],repo,'git-init')
for key,value in [('user.name','AFK Baseline'),('user.email','afk-baseline@example.invalid'),('commit.gpgsign','false')]: subprocess.run(['git','config',key,value],cwd=repo,check=True)
fixture=source/'docs/baselines/2026-10-26-v0.2.0/fixture'
for f in fixture.iterdir(): shutil.copyfile(f,repo/f.name)
afk=str(r/'install/node_modules/afk-geoff/bin/afk.js')
call([node,afk,'init','--runner-profile','codex'],repo,'init')
config=repo/'.afk/config.yaml';config.write_text(config.read_text().replace('verification: []','verification:\n  - node --test'))
brief=(old/'codex/brief.md').read_text()+'\n## Progress Timestamp Compatibility Check\n\nWrite progress.json updatedAt values as ISO 8601 timestamps with the explicit UTC offset +00:00, for example Python datetime.now(timezone.utc).isoformat(). This intentionally exercises AFK watcher compatibility.\n'
(repo/'brief.md').write_text(brief)
call(['git','add','.'],repo,'git-add');call(['git','commit','-m','Set up watcher regression baseline'],repo,'git-commit')
call([node,afk,'doctor','--json'],repo,'doctor')
k=call([node,afk,'run','file','brief.md','--detach','--json'],repo,'kickoff');kickoff=json.loads(k.stdout.splitlines()[-1]);assert kickoff['ok']
run=kickoff['runId'];rd=Path(kickoff['runDir']);start=time.monotonic()
with (r/'watch.stdout').open('w') as out,(r/'watch.stderr').open('w') as err,(r/'raw-progress.ndjson').open('w') as raw:
 watcher=subprocess.Popen([node,afk,'watch',run,'--json'],cwd=repo,env=env,stdout=out,stderr=err)
 last=None
 while watcher.poll() is None:
  try:
   progress=json.loads((rd/'progress.json').read_text())
   if progress.get('updatedAt')!=last:
    raw.write(json.dumps(progress)+'\n');raw.flush();last=progress.get('updatedAt')
  except (FileNotFoundError,json.JSONDecodeError): pass
  if time.monotonic()-start>600: raise RuntimeError('Watch exceeded 10 minutes')
  time.sleep(.25)
 print('single watcher exit',watcher.returncode,flush=True)
for step in ['handoff','inspect']: call([node,afk,step,run,'--json'],repo,step)
h=json.loads((r/'handoff.stdout').read_text());wt=Path(h['worktreePath'])
call([node,str(old/'acceptance.mjs'),str(wt/'label.js')],wt,'acceptance')
call([node,'--test'],wt,'tests');call(['git','status','--porcelain'],wt,'status');call(['git','diff','main...HEAD'],wt,'diff')
print(json.dumps({k:h.get(k) for k in ['runId','workItemId','status','publishable','reviewVerdict','verificationStatus','createdCommitCount','worktreeClean']}),flush=True)
