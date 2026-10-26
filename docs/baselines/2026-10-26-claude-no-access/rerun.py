from pathlib import Path
import subprocess,os,json,time,shutil
root=Path('/private/tmp/afk-claude-no-access-2026-10-26');root.mkdir(exist_ok=True)
source=Path('/Users/david/Documents/ChatGPT/afk-geoff');tools=Path('/private/tmp/afk-baseline-2026-10-26/tools/node_modules/.bin')
node='/Users/david/.nvm/versions/node/v24.14.1/bin/node';npm='/Users/david/.nvm/versions/node/v24.14.1/lib/node_modules/npm/bin/npm-cli.js'
env=os.environ.copy()
# Deliberately test the user's confirmed no-access case. Never inspect credential values.
for key in list(env):
 if key.startswith(('ANTHROPIC_','CLAUDE_','AWS_','GOOGLE_','AZURE_','VERTEX_','BEDROCK_')):
  env.pop(key)
env['PATH']=str(tools)+':/Users/david/.nvm/versions/node/v24.14.1/bin:'+env['PATH']
config=root/'empty-claude-config';config.mkdir(exist_ok=True);env['CLAUDE_CONFIG_DIR']=str(config)
records=[]
def call(args,cwd,label,allow_failure=False,stdin=None):
 start=time.monotonic();p=subprocess.run(args,cwd=cwd,env=env,input=stdin,text=True,capture_output=True,timeout=60)
 (root/(label+'.stdout')).write_text(p.stdout);(root/(label+'.stderr')).write_text(p.stderr)
 records.append({'step':label,'exitCode':p.returncode,'elapsedSeconds':round(time.monotonic()-start,3)})
 print(label,p.returncode,p.stdout[:1000],p.stderr[:200],flush=True)
 if p.returncode and not allow_failure: raise RuntimeError(label)
 return p
call([node,npm,'install','--prefix',str(root/'install'),'/private/tmp/afk-watcher-rerun-2026-10-26/afk-geoff-0.2.0.tgz','--no-audit','--no-fund'],root,'install')
repo=root/'repo';repo.mkdir(exist_ok=True)
call(['git','init','-b','main'],repo,'git-init')
for key,value in [('user.name','AFK Baseline'),('user.email','afk-baseline@example.invalid'),('commit.gpgsign','false')]: subprocess.run(['git','config',key,value],cwd=repo,check=True)
for file in (source/'docs/baselines/2026-10-26-v0.2.0/fixture').iterdir(): shutil.copyfile(file,repo/file.name)
afk=str(root/'install/node_modules/afk-geoff/bin/afk.js')
call([node,afk,'init','--runner-profile','claude'],repo,'init')
p=repo/'.afk/config.yaml';p.write_text(p.read_text().replace('verification: []','verification:\n  - node --test'))
shutil.copyfile(source/'docs/baselines/2026-10-26-v0.2.0/claude/brief.md',repo/'brief.md')
call(['git','add','.'],repo,'git-add');call(['git','commit','-m','Set up no-access Claude baseline'],repo,'git-commit')
call([str(tools/'claude'),'--version'],repo,'claude-version')
call([str(tools/'claude'),'--print','--bare','--permission-mode','bypassPermissions'],repo,'direct-probe',True,'Reply exactly BASELINE_AUTH_OK. Do not use tools.')
call([node,afk,'doctor','--json'],repo,'doctor')
p=call([node,afk,'run','file','brief.md','--detach','--json'],repo,'kickoff');k=json.loads(p.stdout.splitlines()[-1]);assert k['ok']
run=k['runId']
call([node,afk,'watch',run,'--json'],repo,'watch',True)
call([node,afk,'handoff',run,'--json'],repo,'handoff')
call([node,afk,'inspect',run,'--json'],repo,'inspect')
(root/'measurements.json').write_text(json.dumps(records,indent=2)+'\n')
