# OPDS Generator

Генератор статического OPDS каталога из файловой структуры.

**Философия**: примитивные функции, минимум зависимостей (opds-ts), максимальная простота.

## Текущий статус

### Реализовано

- [x] Сканирование директории с книгами
- [x] Stat-based хэширование (path + size + mtime, без чтения содержимого)
- [x] Генерация OPDS Navigation + Acquisition feeds (opds-ts)
- [x] Имя файла (без расширения) → title
- [x] HTTP сервер (Bun.serve + Bun.file)
- [x] Кэширование фидов в $DATA/opds/
- [x] fs.watch — авто-ребилд при изменении файлов (debounce 500ms)
- [x] Dockerfile + docker-compose (dev/prod multi-stage)
- [x] Инкрементальное обновление метаданных ($DATA/raw/)
- [x] Извлечение метаданных из EPUB (title, author, description)
- [x] Извлечение обложек из EPUB, CBZ, ZIP
- [x] Автоопределение типа ZIP (комикс/fb2)
- [x] Endpoint /cover/{path} (1400px max)
- [x] Endpoint /thumbnail/{path} (512px max)
- [x] ETag + If-None-Match для кэширования OPDS

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
├── covers/             # Обложки (1400px max)
│   └── f8a2c1d3-Foundation.epub.jpg
└── thumbnails/         # Превью (512px max)
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

| Endpoint                | Описание                           |
| ----------------------- | ---------------------------------- |
| `GET /opds`             | Корневой каталог (Navigation Feed) |
| `GET /opds/{path}`      | Подкаталог или список книг         |
| `GET /download/{path}`  | Скачивание файла                   |
| `GET /cover/{path}`     | Обложка книги (1400px max)         |
| `GET /thumbnail/{path}` | Превью книги (512px max)           |

## Запуск

```bash
# Разработка (локально)
bun run dev

# Продакшен
FILES=/books DATA=/data PORT=8080 bun run start

# Docker (prod)
docker compose up

# Docker (dev с hot-reload)
docker compose -f docker-compose.dev.yml up
```

## Поддерживаемые форматы

epub, pdf, mobi, azw3, fb2, cbz, cbr, zip, djvu, txt

## OPDS Specification

https://specs.opds.io/opds-1.2

идея:
вынести поддерживаемые форматы в отдельную папку

каждая формат файла должен возвращать два типизированных метода (отдельных или в классе)

- getMetadata
- getCover

идея:
хранить готовый xml и собирать из него
то есть в /data мы храним такой же слепок папок, как и в /files

/files/
/files/comics/
/files/comics/subfolder
/files/comics/Absolute Batman.cbz

/data/
/data/comics/ папка
/data/comics/subfolder папка
/data/comics/Absolute Batman.cbz вместо файла создаём папку

каждая папка в data содержит
feed.xml
entry.xml
thumb.jpg опцианально
cover.jpg опционально

например, мы заходим в opds/comics/
читаем feed.xml

/data/comics/feed.xml

```
<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:dc="http://purl.org/dc/terms/">
  <id>urn:opds:catalog:comics</id>
  <title>comics</title>
  <updated>2025-12-21T09:27:15.563Z</updated>
  <link rel="self" href="http://localhost:8080/opds/comics" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="start" href="http://localhost:8080/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
</feed>
```

и перед закрытием </feed> добавляем все entry.xml вложенных папок

/data/comics/subfolder/entry.xml

```
  <entry>
    <id>urn:opds:catalog:comics/subfolder</id>
    <title>Subfolder</title>
    <updated>2025-12-21T09:27:15.566Z</updated>
    <content type="text">1 books</content> // how much entry.xml in nested folders?
    <link rel="subsection" href="http://localhost:8080/opds/comics/subfolder" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  </entry>
```

/data/comics/Absolute Batman.cbz/entry.xml

```
<entry>
  <id>urn:opds:book:comics/Absolute Batman.cbz</id>
  <title>Absolute Batman</title>
  <updated>2025-12-21T09:27:15.569Z</updated>
  <dc:format>CBZ</dc:format>
  <content type="text">85.0 MB</content>
  <link rel="http://opds-spec.org/image" href="http://localhost:8080/comics/Absolute%20Batman.cbz/cover.jpg" type="image/jpeg"/>
  <link rel="http://opds-spec.org/image/thumbnail" href="http://localhost:8080/comics/Absolute%20Batman.cbz/thumb.jpg" type="image/jpeg"/>
  <link rel="http://opds-spec.org/acquisition/open-access" href="http://localhost:8080/download/comics/Absolute%20Batman.cbz" type="application/vnd.comicbook+zip"/>
</entry>
```

/data/comics/meta.xml содержит сгенерированный xml c информацией О СЕБЕ, название, ссылка, прочее
/data/comics/subfolder/meta.xml содержит сгенерированный xml c информацией О СЕБЕ, название, ссылка, прочее
/data/comics/Absolute Batman.cbz/meta.xml содержит сгенерированный xml c информацией О СЕБЕ, название, ссылка, ссылка на картинку и превью, и прочее
/data/comics/Absolute Batman.cbz/thumb.jpg
/data/comics/Absolute Batman.cbz/cover.jpg

то есть для генерации opds/comics/ нам надо прочитать и собрать вместе все meta.xml из вложенных папок и добавить метаинформацию о текущей папке из info.xml
