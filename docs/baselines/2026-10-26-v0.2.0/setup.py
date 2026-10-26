from pathlib import Path
import subprocess,os,json,time
root=Path('/private/tmp/afk-baseline-2026-10-26')
env=os.environ.copy();env['PATH']=str(root/'tools/node_modules/.bin')+':'+env['PATH']
afk=str(root/'install/node_modules/.bin/afk')
records=[]
def call(args,cwd,label):
 start=time.monotonic();p=subprocess.run(args,cwd=cwd,env=env,text=True,capture_output=True,timeout=60)
 (cwd/(label+'.stdout')).write_text(p.stdout);(cwd/(label+'.stderr')).write_text(p.stderr)
 records.append(dict(profile=cwd.name,step=label,exit=p.returncode,seconds=round(time.monotonic()-start,2)))
 print(cwd.name,label,p.returncode,p.stdout[:1500],p.stderr[:300],flush=True)
 return p
for profile in ['smoke','codex','claude']:
 repo=root/profile;repo.mkdir(exist_ok=True)
 call(['git','init','-b','main'],repo,'git-init')
 subprocess.run(['git','config','user.name','AFK Baseline'],cwd=repo,check=True)
 subprocess.run(['git','config','user.email','afk-baseline@example.invalid'],cwd=repo,check=True)
 subprocess.run(['git','config','commit.gpgsign','false'],cwd=repo,check=True)
 (repo/'package.json').write_text(json.dumps({'name':'afk-baseline-fixture','private':True,'type':'module','scripts':{'test':'node --test'}},indent=2)+'\n')
 (repo/'label.js').write_text('export function normalizeLabel(value) {\n  return value.trim().toLowerCase();\n}\n')
 (repo/'label.test.js').write_text("import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { normalizeLabel } from './label.js';\ntest('trims and lowercases labels', () => { assert.equal(normalizeLabel('  HeLLo  '), 'hello'); });\n")
 (repo/'.gitignore').write_text('*.stdout\n*.stderr\n')
 call([afk,'init','--runner-profile',profile],repo,'afk-init')
 config=repo/'.afk/config.yaml';s=config.read_text();print(profile,'CONFIG',s,flush=True)
 s=s.replace('verification: []','verification:\n  - node --test');config.write_text(s)
 subprocess.run(['git','add','.'],cwd=repo,check=True)
 subprocess.run(['git','commit','-m','Set up clean AFK baseline fixture'],cwd=repo,check=True,stdout=subprocess.DEVNULL)
 brief='''# AFK Execution Brief

## Requirement
Normalize internal whitespace in labels without changing existing trim and lowercase behavior.

## Work Item Title
Normalize whitespace inside labels

## Work Item Body
Update normalizeLabel in label.js. Collapse each run of JavaScript whitespace (spaces, tabs, newlines) to one ASCII space, after trimming and lowercasing. Empty or whitespace-only strings return an empty string. Non-string inputs must throw TypeError. Add behavior tests. Use no dependencies. Commit the change. Do not modify AFK configuration or this brief. Do not publish or contact GitHub.

## Acceptance Criteria
- Leading and trailing whitespace is removed and letters are lowercased.
- Internal whitespace runs become one ASCII space, including tabs and newlines.
- Empty and whitespace-only input returns an empty string.
- Non-string inputs throw TypeError.
- Tests pass and changes are committed with a clean worktree.

## Verification
- node --test
'''
 if profile=='smoke': brief=brief.replace('Update normalizeLabel in label.js.', 'Exercise the smoke runner only; make no source changes. Do not implement the label behavior. Ignore implementation instructions below for this smoke control.')
 (repo/'brief.md').write_text(brief)
 # Keep brief tracked and available to isolated worktrees.
 subprocess.run(['git','add','brief.md'],cwd=repo,check=True)
 subprocess.run(['git','commit','-m','Record baseline brief'],cwd=repo,check=True,stdout=subprocess.DEVNULL)
 call([afk,'doctor','--json'],repo,'doctor')
(root/'setup-records.json').write_text(json.dumps(records,indent=2))
