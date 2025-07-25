export function kotowaza(): string {
  const proverbs: string[] = [
    '七転び八起き',
    '猿も木から落ちる',
    '三人寄れば文殊の知恵',
    '塵も積もれば山となる',
    '花より団子',
    '蛙の子は蛙',
    '石の上にも三年',
    '急がば回れ',
    '出る杭は打たれる',
    '継続は力なり',
    '鯛の尾より鰯の頭',
    '焼け石に水',
    '二兎を追う者は一兎をも得ず',
    '犬も歩けば棒に当たる',
    '情けは人のためならず',
    '案ずるより産むが易し',
    '住めば都',
    '水に流す',
    '覆水盆に返らず',
    '知らぬが仏',
    '弘法にも筆の誤り',
    '百聞は一見に如かず',
    '一石二鳥',
    '論より証拠',
    '転ばぬ先の杖',
    '聞くは一時の恥、聞かぬは一生の恥',
    '善は急げ',
    '口は禍の元',
    '負けるが勝ち',
    '隣の芝生は青い',
    '羹に懲りて膾を吹く',
    '灯台下暗し',
    '坊主憎けりゃ袈裟まで憎い',
    '鬼に金棒',
    '河童の川流れ',
    '窮鼠猫を噛む',
    '年寄りの冷や水',
    '背水の陣',
    '腐っても鯛',
    '画竜点睛',
    '溺れる者は藁をも掴む',
    '泣き面に蜂',
    '虎の威を借る狐',
    '棚からぼたもち',
    '猫に小判',
    '捕らぬ狸の皮算用',
    '風が吹けば桶屋が儲かる',
    '馬の耳に念仏',
    '豚に真珠',
    '後の祭り',
    '亀の甲より年の功',
    '良薬は口に苦し',
    '武士は食わねど高楊枝',
    '下手な鉄砲も数撃ちゃ当たる',
    '蒔かぬ種は生えぬ',
    '毒を食らわば皿まで',
    '骨折り損のくたびれ儲け',
    '雀百まで踊り忘れず',
    '飛んで火に入る夏の虫',
    '渡る世間に鬼はなし',
    '幽霊の正体見たり枯れ尾花',
    '木を見て森を見ず',
    '掃き溜めに鶴',
    '病は気から',
    '身から出た錆',
    '出口のない迷路',
    '絵に描いた餅',
    'のれんに腕押し',
    '暖簾に腕押し',
    '糠喜び',
    '犬猿の仲',
    'どんぐりの背比べ',
    '魚心あれば水心',
    '足元を見る',
    '油断大敵',
    '朝飯前',
    '当たり屋',
    '後の雁が先になる',
    '生き馬の目を抜く',
    '一日の長',
    '一寸の虫にも五分の魂',
    '急がば回れ',
    '板子一枚下は地獄',
    '打てば響く',
    '瓜の蔓に茄子はならぬ',
    '噂をすれば影が差す',
    '江戸の敵を長崎で討つ',
    '海老で鯛を釣る',
    '帯に短し襷に長し',
    '飼い犬に手を噛まれる',
    '壁に耳あり障子に目あり',
    '鴨が葱を背負って来る',
    '枯れ木も山の賑わい',
    '堪忍袋の緒が切れる',
    '聞かぬは一生の恥',
    '聞くは一時の恥',
    '窮すれば通ず',
    '木に竹を接ぐ',
    '今日の飯より明日の種',
    '芸は身を助ける',
    '転ばぬ先の杖',
    '郷に入っては郷に従え',
    '紺屋の白袴',
    '後の祭り',
    '転石苔むさず',
    '去る者は日々に疎し',
    '三つ子の魂百まで',
    '地獄の沙汰も金次第',
    '釈迦に説法',
    '弱肉強食',
    '笑う門には福来る',
    '尻馬に乗る',
    '雀の涙',
    'すり足で立つ',
    '背に腹は代えられぬ',
    '千三つ',
    '袖振り合うも多生の縁',
    '立つ鳥跡を濁さず',
    '玉の輿',
    '爪の垢を煎じて飲む',
    '手前味噌',
    '天につばする',
    '陶犬瓦鶏',
    '時すでに遅し',
    '毒食らわば皿まで',
    '鳶が鷹を生む',
    '灯台下暗し',
    '隣の客はよく柿食う客だ',
    '泣く子と地頭には勝てぬ',
    '菜の花畑',
    '七重の膝を八重に折る',
    '生兵法は怪我の元',
    '憎まれっ子世にはばかる',
    '濡れ手に粟',
    '猫の目のように変わる',
    '念には念を',
    '能ある鷹は爪を隠す',
    '掃き溜めに鶴',
    '破竹の勢い',
    '鳩に豆鉄砲',
    '花実兼ね備わる',
    '腹八分目に医者いらず',
    '人の噂も七十五日',
    '百尺竿頭一歩を進める',
    '瓢箪から駒が出る',
    '船を漕ぐ',
    '仏の顔も三度まで',
    'へそで茶を沸かす',
    '棒に振る',
    '喉元過ぎれば熱さを忘れる',
    '負け犬の遠吠え',
    'ミイラ取りがミイラになる',
    '昔取った杵柄',
    '元の木阿弥',
    '焼け木杭に火がつく',
    '柳に風',
    '藪から棒',
    '山椒は小粒でもぴりりと辛い',
    '良薬口に苦し',
    '老いては子に従え',
    '論より証拠',
    '渡りに船',
    '笑う門には福来る',
  ]
  const randomIndex: number = Math.floor(Math.random() * proverbs.length)
  return proverbs[randomIndex]
}
