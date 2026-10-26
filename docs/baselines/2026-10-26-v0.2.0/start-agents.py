import os,subprocess,time,json
from pathlib import Path
root=Path('/private/tmp/afk-baseline-2026-10-26')
env=os.environ.copy();env['PATH']=str(root/'tools/node_modules/.bin')+':/Users/david/.nvm/versions/node/v24.14.1/bin:'+env['PATH']
node='/Users/david/.nvm/versions/node/v24.14.1/bin/node';afk=str(root/'install/node_modules/afk-geoff/bin/afk.js')
for profile in ['codex','claude']:
 repo=root/profile
 p=subprocess.run([node,afk,'run','file','brief.md','--detach','--json'],cwd=repo,env=env,text=True,capture_output=True,timeout=60)
 (repo/'kickoff.stdout').write_text(p.stdout);(repo/'kickoff.stderr').write_text(p.stderr)
 (repo/'started-at.json').write_text(json.dumps({'time':time.time(),'exit':p.returncode}))
 print(profile,p.returncode,p.stdout,p.stderr,flush=True)
