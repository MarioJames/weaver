package main

import "fmt"

// 包状态与方案中的状态机一致：待定 → 启动中 → 运行中 → 待结论 → 已采纳，另有失败、已取消。
type pkgState int

const (
	statePending pkgState = iota
	stateStarting
	stateRunning
	stateAwaiting
	stateAccepted
	stateFailed
	stateCancelled
)

var stateLabels = [...]string{"待定", "启动中", "运行中", "待结论", "已采纳", "失败", "已取消"}

func (s pkgState) String() string { return stateLabels[s] }

type pkg struct {
	Title   string
	State   pkgState
	Engine  string
	Attempt int
	Minutes int
}

type mission struct {
	Title    string
	Packages []pkg
}

type app struct {
	missions []mission
	selected int
	query    string
}

// 雏形用固定数据：前几行取自真实主任务的工作包标题，其余用来验证长列表。
func newApp(rows int) *app {
	seed := []pkg{
		{"CPC 网关：租户契约 v2（mux、用户级票、订阅授权、在线汇总）", stateAccepted, "codex · gpt-6.1-sol", 1, 14},
		{"Work 服务端：用户级网关票、订阅授权、恢复读取协议版本（契约 v2）", stateAccepted, "codex · gpt-6.1-sol", 2, 21},
		{"规范文档：09-gateway 更新为协议 v2 与分层网关", stateAwaiting, "opencode · deepseek-v4.1-flash", 1, 9},
		{"Ops：平台总览与租户看板接入在线用户数", stateAwaiting, "opencode · deepseek-v4.1-flash", 1, 3},
		{"CPC 网关：多路复用入口（协议 v2）与平台在线汇总", stateRunning, "codex · gpt-6.1-sol", 1, 12},
		{"CPC 网关：设备网关上移到租户层", stateStarting, "codex · gpt-6.1-sol", 1, 0},
		{"浏览器验收：协议 v2 多路复用、在线看板、切换与兼容", statePending, "", 0, 0},
		{"部署资产：协议 v2 发布所需的配置、快照迁移与手册", stateFailed, "opencode · deepseek-v4.1-flash", 1, 6},
	}
	long := append([]pkg(nil), seed...)
	for i := len(seed); i < rows; i++ {
		long = append(long, pkg{
			Title:   fmt.Sprintf("长列表验证用工作包 #%04d", i+1),
			State:   pkgState(i % len(stateLabels)),
			Engine:  "opencode · deepseek-v4.1-flash",
			Attempt: 1 + i%3,
			Minutes: i % 47,
		})
	}
	return &app{missions: []mission{
		{Title: "1113｜FEA｜CPC 网关切换协议 v2", Packages: long},
		{Title: "企业模型授权策略移植（CPC→旗舰版）", Packages: seed[:5]},
		{Title: "1111｜FEA｜企业级知识库", Packages: seed[2:6]},
	}}
}

func (m mission) counts() [len(stateLabels)]int {
	var n [len(stateLabels)]int
	for _, p := range m.Packages {
		n[p.State]++
	}
	return n
}
