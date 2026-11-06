/**
 * 配乐署名数据（Kevin MacLeod / incompetech，CC BY 4.0——有署名义务）。
 * 由 scripts/fetch-incompetech-bgm.mjs 自动生成，请勿手改；
 * 与 resources/bgm/ATTRIBUTION.md 共用这份数据。成品视频描述区须带署名行：
 * 「Music: <曲名> by Kevin MacLeod (incompetech.com) · CC BY 4.0」。
 *
 * 本文件同时承载内置曲库的派生逻辑（情绪标签/署名行生成/署名义务判定），
 * 供主进程曲库服务、渲染层片尾署名、导出完成提示三方共用。
 */

export interface BgmCredit {
  file: string;
  title: string;
  author: string;
  license: string;
  url: string;
}

/** 内置曲库条目（主进程 bgm:getLibrary 返回；path 为绝对路径，供分析/HTTP 注册复用本地曲库数据路径） */
export interface BgmBuiltinTrack extends BgmCredit {
  /** 情绪槽位 id（文件名前缀，如 uplifting） */
  mood: string;
  /** 情绪中文标签（未知前缀回退 id 原文） */
  moodLabel: string;
  /** resources/bgm 下的绝对路径 */
  path: string;
}

/** 情绪槽位中文标签（六情绪 × 2 曲；文件名 `<mood>-N.mp3` 派生） */
export const BGM_MOOD_LABELS: Record<string, string> = {
  uplifting: '振奋',
  calm: '舒缓',
  energetic: '活力',
  dramatic: '悬疑',
  warm: '温暖',
  tech: '科技',
};

/** 从文件名提取情绪槽位（`uplifting-2.mp3` → `uplifting`；无前缀回退 `other`） */
export const bgmMoodFromFile = (file: string): string => {
  const m = /^(.+?)-\d+\.mp3$/i.exec(file ?? '');
  return m ? m[1].toLowerCase() : 'other';
};

/** 从署名 url 提取主机名（`https://incompetech.com/music/...` → `incompetech.com`；解析失败回退完整 url） */
export const creditHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** 标准署名行（片尾烧录/导出提示/描述区复制三处共用同一格式） */
export const bgmCreditLine = (credit: BgmCredit): string =>
  `Music: ${credit.title} by ${credit.author} (${creditHost(credit.url)}) · ${credit.license}`;

/** 是否有署名义务（CC BY 系需要；CC0/无 credit 不需要）——片尾烧录与提示的总开关。
 * 类型谓词：返回 true 时收窄为非空 BgmCredit（调用点免 ! 断言）。 */
export const isAttributionRequired = (credit: BgmCredit | null | undefined): credit is BgmCredit =>
  !!credit && /^CC BY/i.test(credit.license ?? '');


export const BGM_CREDITS: BgmCredit[] = [
  {
    "file": "uplifting-1.mp3",
    "title": "Nothing Broken",
    "author": "Kevin MacLeod",
    "license": "CC BY 4.0",
    "url": "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Nothing%20Broken.mp3"
  },
  {
    "file": "uplifting-2.mp3",
    "title": "How it Begins",
    "author": "Kevin MacLeod",
    "license": "CC BY 4.0",
    "url": "https://incompetech.com/music/royalty-free/mp3-royaltyfree/How%20it%20Begins.mp3"
  },
  {
    "file": "calm-1.mp3",
    "title": "Ripples",
    "author": "Kevin MacLeod",
    "license": "CC BY 4.0",
    "url": "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Ripples.mp3"
  },
  {
    "file": "calm-2.mp3",
    "title": "Morning",
    "author": "Kevin MacLeod",
    "license": "CC BY 4.0",
    "url": "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Morning.mp3"
  },
  {
    "file": "energetic-1.mp3",
    "title": "Shiny Tech",
    "author": "Kevin MacLeod",
    "license": "CC BY 4.0",
    "url": "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Shiny%20Tech.mp3"
  },
  {
    "file": "energetic-2.mp3",
    "title": "Cool Rock",
    "author": "Kevin MacLeod",
    "license": "CC BY 4.0",
    "url": "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Cool%20Rock.mp3"
  },
  {
    "file": "dramatic-1.mp3",
    "title": "At Launch",
    "author": "Kevin MacLeod",
    "license": "CC BY 4.0",
    "url": "https://incompetech.com/music/royalty-free/mp3-royaltyfree/At%20Launch.mp3"
  },
  {
    "file": "dramatic-2.mp3",
    "title": "Impending Boom",
    "author": "Kevin MacLeod",
    "license": "CC BY 4.0",
    "url": "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Impending%20Boom.mp3"
  },
  {
    "file": "warm-1.mp3",
    "title": "Wallpaper",
    "author": "Kevin MacLeod",
    "license": "CC BY 4.0",
    "url": "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Wallpaper.mp3"
  },
  {
    "file": "warm-2.mp3",
    "title": "Wholesome",
    "author": "Kevin MacLeod",
    "license": "CC BY 4.0",
    "url": "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Wholesome.mp3"
  },
  {
    "file": "tech-1.mp3",
    "title": "Aitech",
    "author": "Kevin MacLeod",
    "license": "CC BY 4.0",
    "url": "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Aitech.mp3"
  },
  {
    "file": "tech-2.mp3",
    "title": "Cipher2",
    "author": "Kevin MacLeod",
    "license": "CC BY 4.0",
    "url": "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Cipher2.mp3"
  }
];
