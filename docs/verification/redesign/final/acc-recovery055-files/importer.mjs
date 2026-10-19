export function importRows(existing,rows){
  const items = existing.map(x=>({...x}));
  const seen = new Set(existing.map(x=>x.id));
  const errors = [];
  for(let i=0;i<rows.length;i++){
    const row = rows[i];
    if(row===null||row===undefined||typeof row!=='object'||Array.isArray(row)){
      errors.push({index:i,reason:'row must be a non-null, non-array object'});
      continue;
    }
    const {id,title}=row;
    if(typeof id!=='string'||id.trim()===''){
      errors.push({index:i,reason:'id must be a non-whitespace string'});
      continue;
    }
    if(typeof title!=='string'||title.trim()===''){
      errors.push({index:i,reason:'title must be a non-whitespace string'});
      continue;
    }
    if(seen.has(id)){
      errors.push({index:i,reason:`duplicate id: "${id}"`});
      continue;
    }
    seen.add(id);
    items.push({...row});
  }
  return {items,errors};
}
