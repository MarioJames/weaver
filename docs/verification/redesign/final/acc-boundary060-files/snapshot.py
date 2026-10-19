import os, pathlib, json, hashlib, stat, datetime
base=pathlib.Path(__file__).resolve().parent
workspace=pathlib.Path(json.loads((base/'root.json').read_text())['workspace'])
def collect(path):
 p=pathlib.Path(path)
 if not p.exists() and not p.is_symlink(): return {'exists':False}
 if p.is_symlink(): return {'kind':'symlink','target':os.readlink(p)}
 if p.is_file():
  s=p.stat()
  return {'kind':'file','size':s.st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'mode':oct(stat.S_IMODE(s.st_mode))}
 if p.is_dir():
  return {'kind':'directory','entries':{str(x.relative_to(p)):collect(x) for x in sorted(p.rglob('*')) if not x.is_dir()}}
 return {'kind':'special'}
home=pathlib.Path.home()
paths=[workspace/'fixture',workspace/'.agents',pathlib.Path('/tmp/weaver-redesign-3QuXVe/a'),home/'.codex/auth.json',home/'.codex/config.toml',home/'.claude.json',home/'.claude/settings.json',home/'.config/agents-cooperation/config.json']
for v in ['ACCEPTANCE_HOME','CMDAI_CLAUDE_SETTINGS_PATH']:
 if os.environ.get(v): paths.append(pathlib.Path(os.environ[v]))
result={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'paths':{str(p):collect(p) for p in paths},'coverage':'SHA256/content size/mode; no credential values copied. Includes full fixture, .agents, isolated Weaver data and explicitly located auth/config paths. Excludes unknown provider config locations and concurrent changes outside capture interval.'}
import sys
(base/(sys.argv[1]+'.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
