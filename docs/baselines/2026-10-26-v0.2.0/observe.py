from pathlib import Path
import json,subprocess,sys
r=Path('/private/tmp/afk-baseline-2026-10-26');repo=r/sys.argv[1]
k=json.loads((repo/'kickoff.stdout').read_text().splitlines()[-1]);run=k['runId']
cmd=['/Users/david/.nvm/versions/node/v24.14.1/bin/node',str(r/'install/node_modules/afk-geoff/bin/afk.js')]
for name,args in [('watch',['watch',run,'--json']),('handoff',['handoff',run,'--json']),('inspect',['inspect',run,'--json'])]:
 with (repo/(name+'.stdout')).open('w') as o,(repo/(name+'.stderr')).open('w') as e:
  p=subprocess.run(cmd+args,cwd=repo,stdout=o,stderr=e,timeout=600)
 print(sys.argv[1],name,p.returncode,flush=True)
 if name=='handoff':
  d=json.loads((repo/(name+'.stdout')).read_text());print(json.dumps({k:d.get(k) for k in ['status','publishable','recommendedAction','reviewVerdict','verificationStatus','createdCommitCount','worktreeClean','terminalFailure']}),flush=True)
