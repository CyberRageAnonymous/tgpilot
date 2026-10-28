// The manual, in four languages. Each entry is a section with a title and a
// few blocks of text, so the page can be drawn in any language.

export const HELP = {
  en: [
    {
      title: 'tgpilot in one minute',
      text: 'tgpilot runs your Telegram Serverless bot from a plain folder. You write JavaScript, the cloud runs it — no server to keep alive, no pipeline to babysit. Everything stays on this machine; the bot token never leaves it.',
      items: [
        'The studio in the browser (this one) edits the very files you would edit by hand.',
        'The terminal does the same from the command line — "tgpilot help" lists every command.',
      ],
    },
    {
      title: 'Getting started',
      steps: [
        'Link a bot: open @BotFather, pick your bot, go to Serverless → CLI Access and copy the access token. Paste it into the Link panel in the corner.',
        'Add a handler: every update type is a function. Open Handlers, press "+ module" and pick the update you want to react to.',
        'Try it without deploying: Run in the editor calls the cloud with a sample payload and shows the live logs.',
        'Deploy: Deploy & status → Review changes shows what will go up; confirm and it is live.',
      ],
    },
    {
      title: 'The project layout',
      tree: `mybot/
├── tgcloud/
│   ├── handlers/     one file per update type
│   ├── endpoints/    functions your Mini App can call
│   ├── lib/          shared modules you import
│   └── schema.js     the tables and columns of your database
├── dist/             the Mini App build (optional)
└── tgcloud.jsonc     the project settings`,
      text: 'Only handlers/ and endpoints/ run in the cloud; lib/ is imported by them, and schema.js describes the database. Everything else in the folder is yours — the studio shows it under Other files and never deploys it.',
    },
    {
      title: 'Handlers, endpoints and the database',
      code: `export default async function (message, ctx) {
  await ctx.send('hello');
}`,
      text: 'A handler is one file per update type. An endpoint is a function your Mini App can call over HTTP. schema.js describes your tables; changes to it become migrations you review and apply in the Database section.',
    },
    {
      title: 'Backups',
      text: 'Save a copy of the project before a big change. If the bot breaks, restore the copy with one click — the state at that moment is saved as a backup of its own, so a restore can never destroy work.',
      code: 'tgpilot backup\ntgpilot backups\ntgpilot restore <id>',
    },
    {
      title: 'The bot profile and its button',
      text: 'The bot has a profile of its own: a name, a short and a long description, and the button beside the message field. The studio and the command line edit the same three things; the button can open a Mini App, the command list, or Telegram\'s own menu.',
      code: 'tgpilot bot\ntgpilot bot name "Weather Fox"\ntgpilot bot menu https://example.com/app Open',
    },
    {
      title: 'When the cloud cannot be reached',
      text: 'The Network card says how this machine reaches the cloud: the proxy that is running, the DNS answer and the route. If telegram.org is blocked on your network, point tgpilot at a proxy — HTTP or SOCKS5, the kind is detected on its own.',
      code: 'export TGPILOT_PROXY=socks5://127.0.0.1:10808\ntgpilot ping',
    },
    {
      title: 'The terminal',
      items: [
        'tgpilot status — what differs from the bot',
        'tgpilot diff — the changes, line by line',
        'tgpilot push — deploy the changes',
        'tgpilot run message \'{"text":"hi"}\' — run a handler in the cloud',
        'tgpilot migrate — walk through the database changes',
        'tgpilot webhook — the webhook state',
        'tgpilot logs — the journal of this tool',
        'tgpilot help — the full list',
      ],
    },
    {
      title: 'When something goes wrong',
      text: 'Errors in the studio come as a report: what happened, which file failed and a button that opens the file at the right line.',
      items: [
        'tgpilot logs — everything this tool did',
        'tgpilot ping — is the cloud reachable at all',
        'tgpilot status — does the folder still match the bot',
        'tgpilot backup — save the state before trying something risky',
      ],
    },
  ],

  fa: [
    {
      title: 'tgpilot در یک دقیقه',
      text: 'tgpilot ربات سرورلس تلگرامت را از یک پوشه‌ی ساده اجرا می‌کند. کد جاوااسکریپت را تو می‌نویسی و کلود اجرایش می‌کند — نه سروری که باید زنده نگهش داری، نه خط لوله‌ای که هوسه‌اش را بکشی. همه‌چیز روی همین دستگاه می‌ماند؛ توکن ربات هیچ‌وقت ازش بیرون نمی‌رود.',
      items: [
        'استودیوی مرورگر (همین‌جا) همان فایل‌هایی را ویرایش می‌کند که دستی ویرایش می‌کردی.',
        'ترمینال همین کار را از خط فرمان انجام می‌دهد — «tgpilot help» همه‌ی فرمان‌ها را فهرست می‌کند.',
      ],
    },
    {
      title: 'شروع کار',
      steps: [
        'ربات را وصل کن: @BotFather را باز کن، رباتت را انتخاب کن، برو به Serverless → CLI Access و توکن دسترسی را کپی کن. آن را در پنل «اتصال» گوشه‌ی صفحه بچسبان.',
        'یک هندلر اضافه کن: هر نوع آپدیت یک تابع است. «Handlers» را باز کن، «+ ماژول» را بزن و آپدیتی که می‌خواهی به آن واکنش نشان دهد را انتخاب کن.',
        'بدون انتشار امتحان کن: «اجرا» در ادیتور کلود را با یک داده‌ی نمونه صدا می‌زند و لاگ زنده را نشان می‌دهد.',
        'منتشر کن: «انتشار و وضعیت ← بررسی تغییرات» نشان می‌دهد چه چیزی می‌رود؛ تأیید کن و زنده می‌شود.',
      ],
    },
    {
      title: 'ساختار پروژه',
      tree: `mybot/
├── tgcloud/
│   ├── handlers/     یک فایل برای هر نوع آپدیت
│   ├── endpoints/    توابعی که مینی‌اپ تو صدا می‌زند
│   ├── lib/          ماژول‌های مشترکی که ایمپورت می‌کنی
│   └── schema.js     جدول‌ها و ستون‌های دیتابیست
├── dist/             بیلد مینی‌اپ (اختیاری)
└── tgcloud.jsonc     تنظیمات پروژه`,
      text: 'فقط handlers/ و endpoints/ در کلoud اجرا می‌شوند؛ lib/ را آن‌ها ایمپورت می‌کنند و schema.js دیتابیس را توصیف می‌کند. بقیه‌ی پوشه مال خودت است — استودیو آن‌ها را زیر «بقیه‌ی فایل‌ها» نشان می‌دهد و هیچ‌وقت منتشرشان نمی‌کند.',
    },
    {
      title: 'هندلرها، اندپوینت‌ها و دیتابیس',
      code: `export default async function (message, ctx) {
  await ctx.send('hello');
}`,
      text: 'هر هندلر یک فایل برای یک نوع آپدیت است. اندپوینت تابعی است که مینی‌اپت روی HTTP صدا می‌زند. schema.js جدول‌هایت را توصیف می‌کند و تغییراتش به مهاجرت تبدیل می‌شود که در بخش «دیتابیس» می‌بینی و اعمال می‌کنی.',
    },
    {
      title: 'بکاپ‌ها',
      text: 'قبل از هر تغییر بزرگ یک کپی از پروژه بگیر. اگر ربات خراب شد، با یک کلیک برگردانش — وضعیت همان لحظه خودش یک بکاپ می‌شود، پس بازگردانی هیچ‌وقت کارت را نمی‌خورد.',
      code: 'tgpilot backup\ntgpilot backups\ntgpilot restore <id>',
    },
    {
      title: 'پروفایل ربات و دکمه‌اش',
      text: 'ربات پروفایل خودش را دارد: نام، توضیح کوتاه و بلند، و دکمه‌ی کنار کادر پیام. استودیو و خط فرمان همین سه چیز را ویرایش می‌کنند؛ دکمه می‌تواند یک مینی‌اپ، فهرست دستورات یا منوی خود تلگرام را باز کند.',
      code: 'tgpilot bot\ntgpilot bot name "Weather Fox"\ntgpilot bot menu https://example.com/app Open',
    },
    {
      title: 'وقتی کلود در دسترس نیست',
      text: 'کارت «شبکه» می‌گوید این دستگاه چطور به کلود می‌رسد: پروکسی‌ای که در حال اجراست، جواب DNS و مسیر. اگر تلگرام روی شبکه‌ات بسته است، tgpilot را به یک پروکسی بده — HTTP یا SOCKS5، نوعش خودکار تشخیص داده می‌شود.',
      code: 'export TGPILOT_PROXY=socks5://127.0.0.1:10808\ntgpilot ping',
    },
    {
      title: 'ترمینال',
      items: [
        'tgpilot status — چه چیزی با ربات فرق دارد',
        'tgpilot diff — تغییرات، خط‌به‌خط',
        'tgpilot push — انتشار تغییرات',
        'tgpilot run message \'{"text":"hi"}\' — اجرای یک هندلر در کلود',
        'tgpilot migrate — گام‌به‌گام روی تغییرات دیتابیس',
        'tgpilot webhook — وضعیت وب‌هوک',
        'tgpilot logs — دفترچه‌ی این ابزار',
        'tgpilot help — فهرست کامل',
      ],
    },
    {
      title: 'وقتی مشکلی پیش می‌آید',
      text: 'خطاها در استودیو به‌شکل گزارش می‌آیند: چه شد، کدام فایل خراب است و دکمه‌ای که فایل را روی همان خط باز می‌کند.',
      items: [
        'tgpilot logs — هر کاری که این ابزار کرده',
        'tgpilot ping — اصلاً کلود در دسترس هست یا نه',
        'tgpilot status — آیا پوشه هنوز با ربات می‌خواند',
        'tgpilot backup — قبل از کار خطرناک یک کپی بگیر',
      ],
    },
  ],

  zh: [
    {
      title: '一分钟了解 tgpilot',
      text: 'tgpilot 让你的 Telegram 无服务器机器人从一个普通文件夹运行。你写 JavaScript，云端负责执行 —— 不用养服务器，也不用守着发布流程。所有内容都留在本机，机器人令牌绝不外流。',
      items: [
        '浏览器里的工作室（就是这里）编辑的正是你会手动编辑的那些文件。',
        '终端在命令行里做同样的事 —— 「tgpilot help」列出全部命令。',
      ],
    },
    {
      title: '开始使用',
      steps: [
        '连接机器人：打开 @BotFather，选你的机器人，进入 Serverless → CLI Access 并复制访问令牌，粘贴到角落的「连接」面板。',
        '添加处理器：每种更新类型都是一个函数。打开「处理器」，点「+ 模块」，选择你要响应的更新。',
        '不发布先试用：编辑器里的「运行」会用示例数据调用云端并显示实时日志。',
        '部署：「部署与状态 → 查看改动」会列出将要上线的内容，确认后就生效了。',
      ],
    },
    {
      title: '项目结构',
      tree: `mybot/
├── tgcloud/
│   ├── handlers/     每种更新类型一个文件
│   ├── endpoints/    小程序可以调用的函数
│   ├── lib/          代码里导入的共享模块
│   └── schema.js     数据库的表与字段
├── dist/             小程序构建产物（可选）
└── tgcloud.jsonc     项目设置`,
      text: '只有 handlers/ 和 endpoints/ 会在云端运行；lib/ 由它们导入，schema.js 描述数据库。文件夹里的其他内容都是你的 —— 工作室把它们放在「其他文件」下，永远不会发布它们。',
    },
    {
      title: '处理器、接口与数据库',
      code: `export default async function (message, ctx) {
  await ctx.send('hello');
}`,
      text: '一个处理器对应一种更新类型。接口是小程序通过 HTTP 调用的函数。schema.js 描述你的表，它的改动会变成迁移，可以在「数据库」一节里查看并应用。',
    },
    {
      title: '备份',
      text: '大改动前先存一份项目副本。机器人坏掉时一点即可恢复 —— 恢复前的状态本身也会存成备份，所以恢复绝不会毁掉工作。',
      code: 'tgpilot backup\ntgpilot backups\ntgpilot restore <id>',
    },
    {
      title: '机器人资料与按钮',
      text: '机器人有自己的资料：名称、简短和详细简介，以及消息输入框旁的按钮。工作室和命令行编辑的是同样的三项；按钮可以打开小程序、命令列表，或 Telegram 自带的菜单。',
      code: 'tgpilot bot\ntgpilot bot name "Weather Fox"\ntgpilot bot menu https://example.com/app Open',
    },
    {
      title: '连不上云端时',
      text: '「网络」卡片会说明这台机器如何连到云端：正在运行的代理、DNS 的回答和路由。如果你的网络屏蔽了 telegram.org，就给 tgpilot 指一个代理 —— HTTP 或 SOCKS5 都行，类型会自动识别。',
      code: 'export TGPILOT_PROXY=socks5://127.0.0.1:10808\ntgpilot ping',
    },
    {
      title: '终端',
      items: [
        'tgpilot status — 与机器人的差异',
        'tgpilot diff — 逐行查看改动',
        'tgpilot push — 发布改动',
        'tgpilot run message \'{"text":"hi"}\' — 在云端运行处理器',
        'tgpilot migrate — 逐步走过数据库改动',
        'tgpilot webhook — webhook 状态',
        'tgpilot logs — 本工具的日志',
        'tgpilot help — 完整命令列表',
      ],
    },
    {
      title: '出问题时',
      text: '工作室里的错误会变成一份报告：发生了什么、哪个文件失败，以及一个把光标停在那一行的按钮。',
      items: [
        'tgpilot logs — 这个工具做过的一切',
        'tgpilot ping — 到底能不能连上云端',
        'tgpilot status — 文件夹是否还和机器人一致',
        'tgpilot backup — 冒险之前先存一份',
      ],
    },
  ],

  ru: [
    {
      title: 'tgpilot за минуту',
      text: 'tgpilot запускает вашего Telegram-бота Serverless из обычной папки. Вы пишете JavaScript, облако выполняет — никакого сервера, который надо держать живым, и никакого пайплайна, за которым надо следить. Всё остаётся на этой машине, токен бота её не покидает.',
      items: [
        'Студия в браузере (эта самая) правит ровно те файлы, которые вы правили бы руками.',
        'Терминал делает то же самое из командной строки — «tgpilot help» перечисляет все команды.',
      ],
    },
    {
      title: 'С чего начать',
      steps: [
        'Свяжите бота: откройте @BotFather, выберите бота, зайдите в Serverless → CLI Access и скопируйте токен доступа. Вставьте его в панель «Связать» в углу.',
        'Добавьте обработчик: каждый тип обновления — это функция. Откройте «Обработчики», нажмите «+ модуль» и выберите обновление, на которое хотите реагировать.',
        'Попробуйте без развёртывания: «Запустить» в редакторе вызывает облако с примером и показывает живые логи.',
        'Разверните: «Развёртывание и статус → Посмотреть изменения» покажет, что уйдёт на сервер; подтвердите — и готово.',
      ],
    },
    {
      title: 'Структура проекта',
      tree: `mybot/
├── tgcloud/
│   ├── handlers/     по файлу на тип обновления
│   ├── endpoints/    функции, которые вызывает мини-апп
│   ├── lib/          общие импортируемые модули
│   └── schema.js     таблицы и колонки базы данных
├── dist/             сборка мини-аппа (необязательно)
└── tgcloud.jsonc     настройки проекта`,
      text: 'В облаке выполняются только handlers/ и endpoints/; их импортирует lib/, а schema.js описывает базу. Всё остальное в папке — ваше: студия показывает это в разделе «Прочие файлы» и никогда не разворачивает.',
    },
    {
      title: 'Обработчики, эндпоинты и база',
      code: `export default async function (message, ctx) {
  await ctx.send('hello');
}`,
      text: 'Обработчик — это один файл на тип обновления. Эндпоинт — функция, которую ваш мини-апп вызывает по HTTP. schema.js описывает таблицы; изменения в нём становятся миграциями, которые видно и применяют в разделе «База данных».',
    },
    {
      title: 'Резервные копии',
      text: 'Сохраните копию проекта перед большим изменением. Если бот сломается, верните всё одним щелчком — состояние на тот момент сохраняется отдельной копией, так что восстановление ничего не уничтожит.',
      code: 'tgpilot backup\ntgpilot backups\ntgpilot restore <id>',
    },
    {
      title: 'Профиль бота и его кнопка',
      text: 'У бота есть собственный профиль: имя, краткое и длинное описание, и кнопка рядом с полем ввода. Студия и командная строка правят одно и то же; кнопка может открывать мини-приложение, список команд или меню самого Telegram.',
      code: 'tgpilot bot\ntgpilot bot name "Weather Fox"\ntgpilot bot menu https://example.com/app Open',
    },
    {
      title: 'Когда облако недоступно',
      text: 'Карточка «Сеть» показывает, как эта машина доходит до облака: работающий прокси, ответ DNS и маршрут. Если telegram.org заблокирован, укажите tgpilot прокси — HTTP или SOCKS5, тип определяется сам.',
      code: 'export TGPILOT_PROXY=socks5://127.0.0.1:10808\ntgpilot ping',
    },
    {
      title: 'Терминал',
      items: [
        'tgpilot status — чем отличается от бота',
        'tgpilot diff — изменения построчно',
        'tgpilot push — развернуть изменения',
        'tgpilot run message \'{"text":"hi"}\' — выполнить обработчик в облаке',
        'tgpilot migrate — пройти по изменениям базы данных',
        'tgpilot webhook — состояние вебхука',
        'tgpilot logs — журнал инструмента',
        'tgpilot help — полный список команд',
      ],
    },
    {
      title: 'Когда что-то пошло не так',
      text: 'Ошибки в студии приходят отчётом: что случилось, какой файл не собрался и кнопка, открывающая его на нужной строке.',
      items: [
        'tgpilot logs — всё, что делал инструмент',
        'tgpilot ping — доступно ли облако вообще',
        'tgpilot status — совпадает ли папка с ботом',
        'tgpilot backup — сохранить состояние перед риском',
      ],
    },
  ],
};
