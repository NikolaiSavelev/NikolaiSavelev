const burger = document.querySelector('.burger');
const menu = document.getElementById('menu');
const setMenu = open => {
  menu.classList.toggle('open', open);
  burger.setAttribute('aria-expanded', open);
};
burger.addEventListener('click', () => setMenu(!menu.classList.contains('open')));
menu.addEventListener('click', e => { if (e.target.tagName === 'A') setMenu(false); });

document.getElementById('y').textContent = new Date().getFullYear();

// Заглушка: пока форма не подключена к почте/Telegram, заявка только подтверждается на странице.
document.getElementById('lead').addEventListener('submit', e => {
  e.preventDefault();
  document.getElementById('note').hidden = false;
  e.target.reset();
});
