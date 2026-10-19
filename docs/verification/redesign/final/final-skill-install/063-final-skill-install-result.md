# 063｜已验收 Weaver 技能入口安装完成

依据062授权执行唯一持久写入：新建 `/home/mocha/.agents/skills/weaver` 符号链接，指向 `/home/mocha/opensource/weaver/skills/weaver`。

安装前重查目标不存在；父目录 `/home/mocha/.agents/skills` 是当前用户uid1000所有、可写的目录。创建前再次检查目标状态，以无force的 `ln -s` 原子创建；没有覆盖/删除任何既有资源。

创建后复核：isSymlink=true，realpath=`/home/mocha/opensource/weaver/skills/weaver`，入口SKILL.md frontmatter `name: weaver`。

Canonical validator命令：

```sh
UV_CACHE_DIR=/tmp/weaver-redesign-3QuXVe/uv-cache uv run --no-project --with PyYAML python /home/mocha/.codex/skills/.system/skill-creator/scripts/quick_validate.py /home/mocha/.agents/skills/weaver
```

结果exit0：`Skill is valid!`。

没有重跑041/042、npm link/install、build/fulltest；未写项目source/tests/docs/package/lock/dist、Git index或正式policy/defaultdata，未改其它global技能/config/nativeauth。未提交/push/派发或调用模型。未启动/停止任何服务，用户4737/p52保留。本包无长驻进程；临时空验证目录已回收，正式技能链接保留。060源码freeze与055runtime/build没有由本包改动。现已停写。
