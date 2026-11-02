[session_id: trae-demo-0001 | topic_summary_time: 2026-11-01 10:20:45]
用户先后要求定位登录模块偶发 401 并实施单飞刷新锁。最终定位到并发刷新的竞态，并通过单飞 Promise 修复。

[session_id: trae-demo-0002 | topic_summary_time: 2026-11-01 11:05:00]
用户询问部署脚本为何在 CI 上失败，结论是 Node 版本与 lockfile 不匹配。
