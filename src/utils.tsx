// Helper function to get BGG rating color
export function getRatingColor(rating: string): string {
  const ratingNum = parseFloat(rating);
  if (isNaN(ratingNum) || ratingNum === 0) return '#666e75';
  if (ratingNum < 3) return '#b2151f';
  if (ratingNum < 5) return '#d71925';
  if (ratingNum < 7) return '#5369a2';
  if (ratingNum < 8) return '#1978b3';
  if (ratingNum < 9) return '#1d804c';
  return '#186b40';
}
