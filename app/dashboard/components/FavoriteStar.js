'use client';

export default function FavoriteStar({ fixtureId, isFavorite, onToggle, size = 'default' }) {
  const small = size === 'small';

  function handleClick(e) {
    e.stopPropagation();
    e.preventDefault();
    onToggle(fixtureId);
  }

  return (
    <button
      className={`fav-star${isFavorite ? ' active' : ''}`}
      style={small ? { width: 24, height: 24, fontSize: 12 } : {}}
      onClick={handleClick}
      aria-label={isFavorite ? 'Editar notificaciones del favorito' : 'Agregar a favoritos y elegir notificaciones'}
      title={isFavorite ? 'Editar notificaciones' : 'Agregar a favoritos'}
    >
      {isFavorite ? '★' : '☆'}
    </button>
  );
}
