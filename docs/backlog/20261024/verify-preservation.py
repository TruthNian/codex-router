"""Verify archival patch bytes against the original integrated Git tree."""
import hashlib, json, os, re, subprocess, tempfile
from pathlib import Path

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[2] if HERE.parent.name=='backlog' and HERE.parent.parent.name=='docs' else HERE.parent/'router-upstream-integration-20261024'
manifest=json.loads((HERE/'inventory.json').read_text(encoding='utf-8'))
PREFIX='docs/backlog/20261024/'
def git(*args,input=None,env=None):
    return subprocess.check_output(['git','-C',str(REPO),*args],input=input,env=env)
parts={}; checked=0
for item in manifest['items']:
    if item.get('existingOnly'):
        ref=manifest.get('initialIndexCommit',manifest.get('indexCommit'))
    else: ref=item['archiveCommit']
    patch=git('show',ref+':'+PREFIX+item['id']+'.patch')
    assert hashlib.sha256(patch).hexdigest()==item['patchSha256'],item['id']
    git('apply','--numstat','--unidiff-zero','-',input=patch)
    checked+=1
    if item.get('coverageRole'): continue
    for block in re.split(rb'(?=^diff --git )',patch,flags=re.M):
        if not block: continue
        path=re.match(rb'diff --git a/(.*?) b/.*?\n',block).group(1).decode()
        sections=re.split(rb'(?=^@@ )',block,flags=re.M)
        entry=parts.setdefault(path,{'header':sections[0],'hunks':[]})
        assert entry['header']==sections[0]
        entry['hunks'].extend(sections[1:])
assembled=[]
for path in sorted(parts):
    entry=parts[path]
    hunks=sorted(entry['hunks'],key=lambda h:int(re.match(rb'@@ -(\d+)',h).group(1)))
    assembled.append(entry['header']+b''.join(hunks))
assert len(parts)==manifest['fileCount']
assert sum(len(x['hunks']) for x in parts.values())==manifest['hunkCount']
with tempfile.TemporaryDirectory(prefix='router-archive-index-') as temp:
    env={**os.environ,'GIT_INDEX_FILE':str(Path(temp)/'index')}
    git('read-tree',manifest['base'],env=env)
    git('apply','--cached','--unidiff-zero','-',input=b''.join(assembled),env=env)
    actual=git('write-tree',env=env).decode().strip()
    expected=git('rev-parse',manifest['source']+'^{tree}').decode().strip()
    assert actual==expected,(actual,expected)
print(json.dumps({'patchesVerified':checked,'files':len(parts),'hunks':manifest['hunkCount'],'exactTree':actual,'verified':True}))
