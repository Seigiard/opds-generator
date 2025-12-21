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
- [x] fs.watch — авто-ребилд при изменении файлов (debounce 500ms)
- [x] Dockerfile + docker-compose (dev/prod multi-stage)
- [x] Извлечение метаданных из EPUB (title, author, description)
- [x] Извлечение обложек из EPUB, CBZ, ZIP
- [x] Автоопределение типа ZIP (комикс/fb2)
- [x] Endpoint /cover/{path} (1400px max)
- [x] Endpoint /thumbnail/{path} (512px max)
- [x] ETag + If-None-Match для кэширования OPDS
- [x] Mirror архитектура (/data зеркалит /files)
- [x] FormatHandler интерфейс для расширяемости
- [x] Path sanitization (защита от path traversal)
- [x] Health endpoint (/health)

## Архитектура

### Mirror Architecture

/data зеркалит структуру /files. Каждая книга получает свою папку с метаданными и изображениями.

```
/files/comics/Batman.cbz
/files/comics/subfolder/Book.epub

/data/
  _feed.xml                    # root feed header
  comics/
    _feed.xml                  # feed header
    _entry.xml                 # entry для родительского фида
    Batman.cbz/
      entry.xml                # OPDS entry
      cover.jpg                # 1400px max
      thumb.jpg                # 512px max
    subfolder/
      _feed.xml
      _entry.xml
      Book.epub/
        entry.xml
        cover.jpg
        thumb.jpg
```

### Входные параметры (env)

```
FILES=/path/to/books    # Директория с файлами
DATA=/path/to/cache     # Кэш и метаданные
PORT=8080               # HTTP порт
BASE_URL=http://...     # Базовый URL для ссылок
DEV_MODE=true           # Отключить кэширование
```

### Структура проекта

```
src/
├── index.ts           # Entry point: Bun.serve() + fs.watch
├── scanner.ts         # scanFiles, createSyncPlan, computeHash
├── processor.ts       # processBook, processFolder, XML builders
├── opds.ts            # buildFeed (сборка из файлов)
├── types.ts           # FileInfo, BookEntry, FolderInfo
├── formats/
│   ├── types.ts       # FormatHandler interface
│   ├── index.ts       # getHandler registry
│   ├── epub.ts        # EPUB handler
│   └── cbz.ts         # CBZ/CBR handler
└── utils/
    ├── zip.ts         # ZIP utilities (unzip wrapper)
    └── image.ts       # ImageMagick resize
```

## API

| Endpoint                | Описание                           |
| ----------------------- | ---------------------------------- |
| `GET /opds`             | Корневой каталог (Navigation Feed) |
| `GET /opds/{path}`      | Подкаталог или список книг         |
| `GET /download/{path}`  | Скачивание файла                   |
| `GET /cover/{path}`     | Обложка книги (1400px max)         |
| `GET /thumbnail/{path}` | Превью книги (512px max)           |
| `GET /health`           | Статус сервера (JSON)              |

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

## FormatHandler Interface

```typescript
interface FormatHandler {
  extensions: string[];
  getMetadata(filePath: string): Promise<BookMetadata>;
  getCover(filePath: string): Promise<Buffer | null>;
}
```

## OPDS Specification

https://specs.opds.io/opds-1.2
