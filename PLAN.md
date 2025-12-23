# OPDS Generator

Генератор статического OPDS каталога из файловой структуры.

**Философия**: примитивные функции, минимум зависимостей (opds-ts), максимальная простота.

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
- [x] Извлечение обложек из EPUB, CBZ, CBR, CB7, ZIP
- [x] Автоопределение типа ZIP (комикс/fb2)
- [x] Endpoint /cover/{path} (1400px max)
- [x] Endpoint /thumbnail/{path} (512px max)
- [x] ETag + If-None-Match для кэширования OPDS
- [x] Mirror архитектура (/data зеркалит /files)
- [x] FormatHandler интерфейс для расширяемости
- [x] Path sanitization (защита от path traversal)
- [x] Health endpoint (/health)
- [x] Natural sorting (Intl.Collator)
- [x] oxlint type-aware linting
- [x] EPUB: fast-xml-parser, EPUB 3.0 cover, fallback chain
- [x] FB2: metadata + cover extraction
- [x] MOBI/AZW: binary parsing with DataView, metadata + cover
- [x] CBZ/CBR/CB7: ComicInfo.xml + CoMet parsing with fast-xml-parser
- [x] PDF: pdfinfo + pdftoppm (poppler-utils) for metadata + cover
- [x] Reset endpoint (/reset in DEV_MODE)
- [x] Security: path traversal protection (resolveSafePath)
- [x] Reliability: sync dirty flag, process lifecycle fixes

Критические проблемы

| Проблема         | Влияние                                             |
| ---------------- | --------------------------------------------------- |
| Нет тестов       | Рефакторинг опасен, регрессии неизбежны             |
| Тихие ошибки     | 20+ мест с catch { return null } — дебаг невозможен |
| Конфигурация     | env-переменные без валидации                        |
| Типобезопасность | Небезопасный доступ к массивам                      |

Топ-5 рекомендаций по приоритету

1.  Error handling — src/utils/errors.ts с классами ошибок и logError()
2.  Config validation — src/config.ts с проверкой env
3.  Тесты — bun test, начать с format handlers
4.  Concurrent processing — параллельная обработка книг (5x быстрее)
5.  Route extraction — вынести 60+ строк из index.ts в routes.ts

Быстрые победы (30 минут)

- Убрать magic numbers → src/constants.ts
- Вынести XML parser creation в utils.ts
- Добавить bounds checking для массивов

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
│   ├── utils.ts       # Shared XML parsing utilities
│   ├── epub.ts        # EPUB handler (fast-xml-parser)
│   ├── fb2.ts         # FB2 handler
│   ├── mobi.ts        # MOBI/AZW handler (binary parsing)
│   └── comic.ts       # CBZ/CBR/CB7/ZIP handler
└── utils/
    ├── archive.ts     # ZIP/RAR/7z extraction
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
| `GET /reset`            | Очистка кэша (только DEV_MODE)     |

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

epub, pdf, mobi, azw3, fb2, cbz, cbr, cb7, zip, djvu, txt

## FormatHandler Interface

```typescript
interface FormatHandler {
  getMetadata(): BookMetadata;
  getCover(): Promise<Buffer | null>;
}

type FormatHandlerFactory = (filePath: string) => Promise<FormatHandler | null>;

interface FormatHandlerRegistration {
  extensions: string[];
  create: FormatHandlerFactory;
}
```

## OPDS Specification

https://specs.opds.io/opds-1.2
