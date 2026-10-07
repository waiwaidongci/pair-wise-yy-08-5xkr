import { ArrowBack, CallMerge, GraphicEq, History, Loop, Mic, Storage, Tune, Waves } from '@mui/icons-material';
import { Button, Card, CardContent, Stack, Typography } from '@mui/material';
import { Link } from 'react-router-dom';

const TOPICS = [
  {
    icon: <Waves />,
    title: '波形与时间轴',
    body: '波形按“take + 片段修订号 + 边界 + 缩放”缓存。循环区间或片段边界一变，只作废并重算受牵连片段，其余片段直接命中缓存。',
  },
  {
    icon: <Mic />,
    title: 'Take 叠录',
    body: '选中片段后点红色录音，每轮补录都会留下独立 take，主轨只引用选中的 take 段落；原 take 不会被覆盖，可在右侧检查器随时重选。',
  },
  {
    icon: <History />,
    title: '恢复上一个 take',
    body: '刚叠录完若不满意，点素材库中的“撤销最近一次叠录”即可恢复上一个 take；录音保存失败也不会丢掉已录声音。',
  },
  {
    icon: <Storage />,
    title: '容量保护',
    body: '素材库空间不足时会先拒绝新 take：当前录音保留并列入“未保存录音”，支持清理空间后重试或先下载到本地，当前工程不受影响。',
  },
  {
    icon: <CallMerge />,
    title: '双页签合并',
    body: '两个页签同时改一个工程时，take 按编号合并、双方声音都保留；双方都改过的同一片段先标记冲突，在检查器里选择保留本地或采用对方。',
  },
  {
    icon: <Tune />,
    title: '效果与混音',
    body: '每个片段支持淡入、淡出、低通、高通和 Echo。轨道提供音量、声像、静音和独奏控制。',
  },
  {
    icon: <Loop />,
    title: '导出预案',
    body: '循环区间或片段边界变化时导出预案自动重算（签名改变），导出的工程 JSON 内含每个 take 段落的区间、修订号与引用关系。',
  },
  {
    icon: <GraphicEq />,
    title: '旧工程升级',
    body: '旧版工程没有 take 编号，打开时会先把每个片段补齐为 take 1、升级到 v2，完成后才允许继续编辑。',
  },
];

export function HelpPage() {
  return (
    <div className="help-page">
      <header>
        <div>
          <Typography className="eyebrow">WORKSTATION GUIDE</Typography>
          <Typography variant="h4">WaveForge 使用指南</Typography>
          <Typography color="text.secondary">
            浏览器内的多轨音频编辑流程与快捷键说明。
          </Typography>
        </div>
        <Link to="/studio">
          <Button variant="contained" startIcon={<ArrowBack />}>返回工作站</Button>
        </Link>
      </header>
      <main>
        <div className="help-grid">
          {TOPICS.map((topic) => (
            <Card key={topic.title} variant="outlined">
              <CardContent>
                <span className="help-icon">{topic.icon}</span>
                <Typography variant="h6">{topic.title}</Typography>
                <Typography color="text.secondary">{topic.body}</Typography>
              </CardContent>
            </Card>
          ))}
        </div>
        <Card variant="outlined">
          <CardContent>
            <Stack direction="row" alignItems="center" spacing={1}>
              <GraphicEq color="primary" />
              <Typography variant="h6">快捷键</Typography>
            </Stack>
            <div className="shortcut-grid">
              <span><kbd>Space</kbd><em>播放 / 暂停</em></span>
              <span><kbd>拖动片段</kbd><em>移动或跨轨</em></span>
              <span><kbd>左右边缘</kbd><em>裁剪片段</em></span>
              <span><kbd>时间轴标尺</kbd><em>定位播放头</em></span>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
