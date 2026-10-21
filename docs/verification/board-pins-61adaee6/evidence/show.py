import json,sys
s=open(sys.argv[1]).read()
d=json.loads(s)
if isinstance(d,str): d=json.loads(d)
for k,v in d.items():
  print(k,v['head'],'collapsed='+str(v['collapsed']),v['viewAll'])
  for r in v['rows']: print('   ',r)
