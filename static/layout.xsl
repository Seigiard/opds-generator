<?xml version="1.0" encoding="UTF-8" ?>
<xsl:stylesheet
  version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:dc="http://purl.org/dc/terms/"
>

  <xsl:output method="html" encoding="UTF-8" />

  <!-- Main template -->
  <xsl:template match="/">
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title><xsl:value-of select="atom:feed/atom:title" /></title>
        <link rel="stylesheet" href="/static/style.css" />
      </head>
      <body>
        <header class="header">
          <div class="header__left">
            <nav class="header__breadcrumb">
              <a class="header__home" href="/feed.xml" aria-label="Home">
                <svg class="header__icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
                </svg>
              </a>
              <xsl:if test="atom:feed/atom:link[@rel='up']">
                <span class="header__separator" aria-hidden="true">›</span>
                <span class="header__breadcrumb-text"><xsl:value-of select="atom:feed/atom:title" /></span>
              </xsl:if>
            </nav>
            <h1 class="header__title"><xsl:value-of select="atom:feed/atom:title" /></h1>
          </div>
          <!-- search hidden -->
        </header>

        <main class="books-grid">
          <xsl:for-each select="atom:feed/atom:entry">
            <xsl:choose>
              <xsl:when test="atom:link[@rel='subsection']">
                <xsl:call-template name="folder" />
              </xsl:when>
              <xsl:otherwise>
                <xsl:call-template name="book" />
              </xsl:otherwise>
            </xsl:choose>
          </xsl:for-each>
        </main>
      </body>
    </html>
  </xsl:template>

  <!-- Folder template -->
  <xsl:template name="folder">
    <div>
      <article class="card card--folder">
        <div class="book" aria-hidden="true">
          <div class="book__cover">
            <span><xsl:value-of select="atom:title" /></span>
          </div>
        </div>
        <div class="book" aria-hidden="true">
          <div class="book__cover">
            <span><xsl:value-of select="atom:title" /></span>
          </div>
        </div>
        <div class="book" aria-hidden="true">
          <div class="book__cover">
            <span><xsl:value-of select="atom:title" /></span>
          </div>
        </div>
        <div class="card__info">
          <h3 class="card__title">
            <a href="{atom:link[@rel='subsection']/@href}"><xsl:value-of select="atom:title" /></a>
          </h3>
          <xsl:if test="atom:summary">
            <p><xsl:value-of select="atom:summary" /></p>
          </xsl:if>
        </div>
      </article>
    </div>
  </xsl:template>

  <!-- Book template -->
  <xsl:template name="book">
    <div>
      <article class="card card--book popup-trigger__wrapper">
        <div class="book" aria-hidden="true">
          <div class="book__cover">
            <xsl:choose>
              <xsl:when test="atom:link[@rel='http://opds-spec.org/image/thumbnail']">
                <img
                  src="{atom:link[@rel='http://opds-spec.org/image/thumbnail']/@href}"
                  alt="{atom:title}"
                  loading="lazy"
                />
              </xsl:when>
              <xsl:otherwise>
                <span><xsl:value-of select="atom:title" /></span>
              </xsl:otherwise>
            </xsl:choose>
          </div>
        </div>
        <div class="card__info">
          <h3 class="card__title"><xsl:value-of select="atom:title" /></h3>
          <xsl:if test="atom:author">
            <p><xsl:value-of select="atom:author/atom:name" /></p>
          </xsl:if>
        </div>
        <label class="popup-trigger">
          <input type="checkbox" name="open-popup" />
          <span class="show">Open Book Details</span>
          <span class="hide">Hide Book Details</span>
        </label>
      </article>

      <div class="popup">
        <div class="popup__content">
          <div class="popup__cover" aria-hidden="true">
            <div class="book">
              <div class="book__cover">
                <xsl:choose>
                  <xsl:when test="atom:link[@rel='http://opds-spec.org/image']">
                    <img src="{atom:link[@rel='http://opds-spec.org/image']/@href}" alt="{atom:title}" />
                  </xsl:when>
                  <xsl:when test="atom:link[@rel='http://opds-spec.org/image/thumbnail']">
                    <img src="{atom:link[@rel='http://opds-spec.org/image/thumbnail']/@href}" alt="{atom:title}" />
                  </xsl:when>
                  <xsl:otherwise>
                    <span><xsl:value-of select="atom:title" /></span>
                  </xsl:otherwise>
                </xsl:choose>
              </div>
            </div>
          </div>
          <div class="popup__info">
            <hgroup>
              <h2 class="popup__title"><xsl:value-of select="atom:title" /></h2>
              <xsl:if test="atom:author">
                <p class="popup__author"><xsl:value-of select="atom:author/atom:name" /></p>
              </xsl:if>
            </hgroup>

            <xsl:if test="atom:summary">
              <p class="popup__description"><xsl:value-of select="atom:summary" /></p>
            </xsl:if>

            <div class="popup__footer">
              <xsl:if test="dc:subject or dc:format or atom:content or dc:issued or dc:language or dc:isPartOf">
                <div class="popup__meta">
                  <xsl:if test="dc:subject">
                    <span>
                      <xsl:for-each select="dc:subject">
                        <xsl:value-of select="." />
                        <xsl:if test="position() != last()">, </xsl:if>
                      </xsl:for-each>
                    </span>
                  </xsl:if>
                  <xsl:if test="dc:format or atom:content">
                    <span>
                      <xsl:if test="dc:format"><xsl:value-of select="dc:format" /></xsl:if>
                      <xsl:if test="dc:format and atom:content"> · </xsl:if>
                      <xsl:if test="atom:content"><xsl:value-of select="atom:content" /></xsl:if>
                    </span>
                  </xsl:if>
                  <xsl:if test="dc:issued or dc:language">
                    <span>
                      <xsl:if test="dc:issued"><xsl:value-of select="dc:issued" /></xsl:if>
                      <xsl:if test="dc:issued and dc:language"> · </xsl:if>
                      <xsl:if test="dc:language"><xsl:value-of select="dc:language" /></xsl:if>
                    </span>
                  </xsl:if>
                  <xsl:if test="dc:isPartOf">
                    <span><xsl:value-of select="dc:isPartOf" /></span>
                  </xsl:if>
                </div>
              </xsl:if>

              <xsl:if test="atom:link[contains(@rel,'acquisition')]">
                <div class="popup__downloads">
                  <xsl:for-each select="atom:link[contains(@rel,'acquisition')]">
                    <a href="{@href}" class="popup__download-btn">
                      <xsl:call-template name="format-from-mime">
                        <xsl:with-param name="type" select="@type" />
                      </xsl:call-template>
                    </a>
                  </xsl:for-each>
                </div>
              </xsl:if>
            </div>
          </div>
        </div>
      </div>
    </div>
  </xsl:template>

  <!-- MIME to Format name -->
  <xsl:template name="format-from-mime">
    <xsl:param name="type" />
    <xsl:choose>
      <xsl:when test="contains($type, 'epub')">EPUB</xsl:when>
      <xsl:when test="contains($type, 'pdf')">PDF</xsl:when>
      <xsl:when test="contains($type, 'fb2') or contains($type, 'fictionbook')">FB2</xsl:when>
      <xsl:when test="contains($type, 'mobi')">MOBI</xsl:when>
      <xsl:when test="contains($type, 'azw')">AZW3</xsl:when>
      <xsl:when test="contains($type, 'djvu')">DJVU</xsl:when>
      <xsl:when
        test="contains($type, 'comicbook') or contains($type, 'cbz') or contains($type, 'cbr') or contains($type, '7z') or contains($type, 'tar')"
      >Comic</xsl:when>
      <xsl:when test="contains($type, 'text/plain')">TXT</xsl:when>
      <xsl:otherwise>Download</xsl:otherwise>
    </xsl:choose>
  </xsl:template>

</xsl:stylesheet>
