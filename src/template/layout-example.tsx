import { ComponentPropsWithoutRef } from "react";

export function BooksGrid(props: ComponentPropsWithoutRef<"div">) {
  return <div className="books-grid" {...props} />;
}

export function Folder({
  title,
  href,
  description,
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  title: string;
  href: string;
  description?: string;
}) {
  return (
    <div>
      <article {...props} className="card card--folder">
        <div className="book" aria-hidden>
          <div className="book__cover">
            <span>{title}</span>
          </div>
        </div>
        <div className="book" aria-hidden>
          <div className="book__cover">
            <span>{title}</span>
          </div>
        </div>
        <div className="book" aria-hidden>
          <div className="book__cover">
            <span>{title}</span>
          </div>
        </div>
        <div className="card__info">
          <h3 className="card__title">
            <a href={href}>{title}</a>
          </h3>
          {description && <p className="card__description">{description}</p>}
        </div>
      </article>
    </div>
  );
}

export function Book({
  cover,
  title,
  author,
  description,
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  cover?: string;
  title: string;
  author?: string;
  description?: string;
}) {
  return (
    <div>
      <article {...props} className="card card--book popup-trigger__wrapper">
        <div className="book book--animated" aria-hidden>
          <div className="book__cover">
            {cover ? <img src={cover} alt={title} loading="lazy" /> : <span>{title}</span>}
          </div>
        </div>
        <div className="card__info">
          <h3 className="card__title">{title}</h3>
          {author && <p className="card__description">{author}</p>}
        </div>
        <label className="popup-trigger">
          <input type="checkbox" name="open-popup" />
          <span className="show">Open Book Details</span>
          <span className="hide">Hide Book Details</span>
        </label>
      </article>
      <div className="popup">
        <div className="popup__content">
          <div className="popup__cover" aria-hidden>
            <div className="book">
              <div className="book__cover">{cover ? <img src={cover} alt={title} /> : <span>{title}</span>}</div>
            </div>
          </div>
          <div className="popup__info">
            <hgroup>
              <h2 className="popup__title">{title}</h2>
              {author && <p className="popup__author">{author}</p>}
            </hgroup>
            {description && <p className="popup__description">{description}</p>}
            <div className="popup__footer">
              <p className="popup__meta">
                <span>Fiction, Drama, Classic</span>
                <span>2024 &nbsp;·&nbsp; English</span>
              </p>

              <div className="popup__downloads">
                <a href="#" className="popup__download-btn">
                  EPUB
                </a>
                <a href="#" className="popup__download-btn">
                  PDF
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
