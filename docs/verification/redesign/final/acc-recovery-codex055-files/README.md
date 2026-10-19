修复importer.mjs的importRows(existing,rows)，返回{items,errors}，items保留existing顺序，追加有效新行；每行必须对象且id/title非空string，重复id（含existing）拒绝并逐条记录errors，原输入不变。执行node --test test.mjs并补边界测试，不删改已有断言。
