# OPDS Generator

Генератор статического OPDS каталога из файловой структуры.

**Философия**: примитивные функции, 0 зависимостей, максимальная простота.

## Текущий статус

### Реализовано
- [x] Сканирование директории с книгами
- [x] Stat-based хэширование (path + size + mtime, без чтения содержимого)
- [x] Генерация OPDS Navigation + Acquisition feeds
- [x] Имя файла (без расширения) → title
- [x] HTTP сервер (Bun.serve + Bun.file)
- [x] Кэширование фидов в $DATA/opds/
- [x] fs.watch — авто-ребилд при изменении файлов (debounce 500ms)
- [x] Dockerfile + docker-compose
- [x] Инкрементальное обновление метаданных ($DATA/raw/)
- [x] Извлечение метаданных из EPUB (title, author, description)
- [x] Извлечение обложек из EPUB, CBZ, ZIP
- [x] Автоопределение типа ZIP (комикс/fb2)
- [x] Endpoint /cover/{path}

## Архитектура

### Входные параметры (env)
```
FILES=/path/to/books    # Директория с файлами
DATA=/path/to/cache     # Кэш и метаданные
PORT=8080               # HTTP порт
BASE_URL=http://...     # Базовый URL для ссылок
```

### Структура $DATA
```
$DATA/
├── manifest.json       # Хэш каталога + индекс файлов
├── opds/               # Сгенерированные OPDS фиды
│   ├── root.xml
│   └── fiction--scifi.xml
├── raw/                # Кэш метаданных
│   └── f8a2c1d3-Foundation.epub.json
└── covers/             # Обложки
    └── f8a2c1d3-Foundation.epub.jpg
```

### Структура проекта
```
src/
├── index.ts      # Entry point: Bun.serve() + fs.watch
├── scanner.ts    # scanDirectory, computeHash
├── manifest.ts   # readManifest, writeManifest
├── metadata.ts   # extractBasicMeta, cover extraction
├── opds.ts       # buildFeed, escapeXml
├── types.ts      # FileInfo, BookMeta, Manifest
├── zip.ts        # ZIP utilities (unzip wrapper)
├── epub.ts       # EPUB metadata parser
└── cbz.ts        # CBZ/comic metadata parser
```

## API

| Endpoint | Описание |
|----------|----------|
| `GET /opds` | Корневой каталог (Navigation Feed) |
| `GET /opds/{path}` | Подкаталог или список книг |
| `GET /download/{path}` | Скачивание файла |
| `GET /cover/{path}` | Обложка книги |

## Запуск

```bash
# Разработка
bun run dev

# Продакшен
FILES=/books DATA=/data PORT=8080 bun run start

# Docker
docker-compose up
```

## Поддерживаемые форматы
epub, pdf, mobi, azw3, fb2, cbz, cbr, zip, djvu, txt

## OPDS Specification
https://specs.opds.io/opds-1.2
