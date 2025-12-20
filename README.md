# OPDS Generator

Генератор статического OPDS 1.2 каталога из файловой структуры.

**Философия**: примитивные функции, 0 зависимостей, максимальная простота.

## Возможности

- Автоматическое сканирование директории с книгами
- Извлечение метаданных из EPUB (title, author, description)
- Извлечение обложек из EPUB, CBZ, ZIP
- Автоопределение типа ZIP (комикс или fb2)
- Авто-ребилд при изменении файлов (fs.watch)
- Инкрементальное кэширование метаданных

## Поддерживаемые форматы

| Формат | Метаданные | Обложка |
|--------|------------|---------|
| EPUB | title, author, description | ✓ |
| CBZ/CBR | title, author (ComicInfo.xml) | ✓ |
| ZIP | автоопределение (комикс/fb2) | ✓ |
| PDF, MOBI, FB2, DJVU, TXT | имя файла | - |

## Быстрый старт с Docker

### Docker Compose (рекомендуется)

1. Создайте `docker-compose.yml`:

```yaml
services:
  opds:
    image: ghcr.io/seigiard/opds-generator:latest
    ports:
      - "8080:8080"
    volumes:
      - /path/to/your/books:/books:ro
      - opds-data:/data
    environment:
      - BASE_URL=http://localhost:8080
    restart: unless-stopped

volumes:
  opds-data:
```

2. Запустите:

```bash
docker-compose up -d
```

3. Откройте http://localhost:8080/opds

### Docker Run

```bash
docker run -d \
  --name opds \
  -p 8080:8080 \
  -v /path/to/your/books:/books:ro \
  -v opds-data:/data \
  -e BASE_URL=http://your-server:8080 \
  ghcr.io/seigiard/opds-generator:latest
```

### Сборка из исходников

```bash
git clone https://github.com/Seigiard/opds-generator.git
cd opds-generator
docker-compose up -d --build
```

## Переменные окружения

| Переменная | По умолчанию | Описание |
|------------|--------------|----------|
| `FILES` | `/books` | Путь к директории с книгами |
| `DATA` | `/data` | Путь для кэша и метаданных |
| `PORT` | `8080` | HTTP порт |
| `BASE_URL` | `http://localhost:8080` | Базовый URL для ссылок в OPDS |

## API

| Endpoint | Описание |
|----------|----------|
| `GET /opds` | Корневой каталог |
| `GET /opds/{path}` | Подкаталог или список книг |
| `GET /download/{path}` | Скачивание файла |
| `GET /cover/{path}` | Обложка книги |

## Структура директорий

```
/books/                    # Ваши книги (монтируется)
├── fiction/
│   ├── scifi/
│   │   └── Foundation.epub
│   └── fantasy/
│       └── Dune.epub
└── comics/
    └── Batman.cbz

/data/                     # Кэш (автоматически)
├── manifest.json
├── opds/
│   ├── root.xml
│   └── fiction--scifi.xml
├── raw/                   # Метаданные книг
│   └── abc123-Foundation.epub.json
└── covers/                # Обложки
    └── abc123-Foundation.epub.jpg
```

## Разработка

```bash
# Установка зависимостей
bun install

# Запуск dev сервера с hot reload
bun run dev

# Продакшен
FILES=/books DATA=/data bun run start
```

## OPDS Specification

https://specs.opds.io/opds-1.2

## Лицензия

MIT
