<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:dc="http://purl.org/dc/terms/">

  <xsl:output method="html" encoding="UTF-8"/>

  <xsl:template match="/">
    <html lang="en">
      <head>
        <meta charset="UTF-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <title><xsl:value-of select="atom:feed/atom:title"/></title>
        <link rel="stylesheet" href="/static/style.css"/>
      </head>
      <body>
        <header>
          <nav><a href="/feed.xml">Home</a></nav>
          <h1><xsl:value-of select="atom:feed/atom:title"/></h1>
        </header>
        <main>
          <xsl:for-each select="atom:feed/atom:entry">
            <xsl:call-template name="entry"/>
          </xsl:for-each>
        </main>
      </body>
    </html>
  </xsl:template>

  <xsl:template name="entry">
    <article>
      <xsl:if test="atom:link[@rel='http://opds-spec.org/image/thumbnail']">
        <img src="{atom:link[@rel='http://opds-spec.org/image/thumbnail']/@href}" alt=""/>
      </xsl:if>

      <h2>
        <xsl:choose>
          <xsl:when test="atom:link[@rel='subsection']">
            <a href="{atom:link[@rel='subsection']/@href}"><xsl:value-of select="atom:title"/></a>
          </xsl:when>
          <xsl:otherwise>
            <xsl:value-of select="atom:title"/>
          </xsl:otherwise>
        </xsl:choose>
      </h2>

      <xsl:if test="atom:author">
        <p><xsl:value-of select="atom:author/atom:name"/></p>
      </xsl:if>

      <xsl:if test="atom:summary">
        <p><xsl:value-of select="atom:summary"/></p>
      </xsl:if>

      <xsl:if test="dc:format or atom:content">
        <p>
          <xsl:if test="dc:format"><xsl:value-of select="dc:format"/></xsl:if>
          <xsl:if test="dc:format and atom:content"> · </xsl:if>
          <xsl:if test="atom:content"><xsl:value-of select="atom:content"/></xsl:if>
        </p>
      </xsl:if>

      <xsl:if test="atom:link[contains(@rel,'acquisition')]">
        <p><a href="{atom:link[contains(@rel,'acquisition')]/@href}">Download</a></p>
      </xsl:if>
    </article>
  </xsl:template>
</xsl:stylesheet>
