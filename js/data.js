// Встроенный каталог. Товары, которые добавляет администратор, приходят с сервера.
// Фото: img/products/<файл>.jpg, для каталога — уменьшенная копия <файл>-thumb.jpg.

export const CATEGORIES = [["run", "Бег"], ["gym", "Зал"], ["street", "Повседневное"]];

export const COLOR_NAMES = {
  "#E8392E": "Красный", "#7FA88A": "Шалфей", "#0E2A47": "Тёмно-синий", "#E4E8EC": "Белый",
  "#1B1B1F": "Чёрный", "#8A97A5": "Серый меланж", "#3A3D42": "Тёмно-серый",
};

export const DELIVERY_METHODS = [
  { id: "cdek", title: "СДЭК", hint: "Пункт выдачи", addressLabel: "Пункт выдачи СДЭК", placeholder: "Город, адрес пункта выдачи" },
  { id: "post", title: "Почта России", hint: "В отделение", addressLabel: "Индекс и адрес", placeholder: "101000, Москва, ул. Мясницкая, 1, кв. 1" },
  { id: "city", title: "По городу", hint: "Курьер до двери", addressLabel: "Адрес доставки", placeholder: "Улица, дом, квартира, подъезд" },
  { id: "pickup", title: "Самовывоз", hint: "Из магазина", addressLabel: null },
];

const img = (file) => `img/products/${file}.jpg`;
const SIZES = ["S", "M", "L", "XL", "XXL"];

// photo — основное фото; colorPhotos — отдельные фото для цветов (без них у всех цветов одно фото).
export const BASE_PRODUCTS = [
  { id: 1, category: "run", name: "Беговая футболка Airline", price: 2990, oldPrice: 3990, isNew: false,
    description: "Сетчатые вставки на спине, отводит влагу, светоотражающий логотип.",
    colors: ["#E4E8EC"], sizes: SIZES, soldOutSizes: ["S"],
    photo: "1-pants.jpg", photoPosition: "55% 50%", photoAuthor: "Niko Twisty" },
  { id: 2, category: "street", name: "Спортивные штаны Fleece", price: 4290, isNew: true,
    description: "Плотный футер с начёсом, прямой свободный крой, широкая резинка с кулиской и боковые карманы. На фото все три цвета модели.",
    colors: ["#A7A9AB", "#3E3834", "#1B1B1F"], colorNames: { "#A7A9AB": "Серый меланж", "#3E3834": "Графит", "#1B1B1F": "Чёрный" },
    sizes: SIZES, photo: img("2"), photoPosition: "50% 45%", photoAuthor: "Ebenezer Idowu" },
  { id: 3, category: "gym", name: "Спортивные штаны Core", price: 4790, isNew: false,
    description: "Мягкий хлопковый футер, свободный крой с манжетами внизу, резинка с кулиской и глубокие карманы.",
    colors: ["#D9CBB4"], colorNames: { "#D9CBB4": "Бежевый" }, sizes: SIZES, soldOutSizes: ["S"],
    photo: img("3"), photoPosition: "50% 100%", photoAuthor: "Monstera Production" },
  { id: 4, category: "gym", name: "Майка Hold для зала", price: 1990, isNew: true,
    description: "Глубокие проймы, лёгкая быстросохнущая ткань, не липнет к телу.",
    colors: ["#8A97A5"], sizes: SIZES, photo: img("4"), photoPosition: "50% 35%", photoAuthor: "cottonbro studio" },
  { id: 5, category: "street", name: "Худи Warmup", price: 5990, oldPrice: 7490, isNew: false,
    description: "Хлопок с начёсом, 380 г/м², капюшон на двойной подкладке, карман-кенгуру.",
    colors: ["#D8C8B0", "#1B1B1F"], colorNames: { "#D8C8B0": "Бежевый", "#1B1B1F": "Чёрный" }, sizes: SIZES,
    photo: img("5-beige"), colorPhotos: { "#D8C8B0": img("5-beige"), "#1B1B1F": img("5-black") },
    photoPosition: "50% 32%", photoAuthor: "Monstera Production" },
  { id: 6, category: "run", name: "Ветровка Tempo Shell", price: 7990, isNew: true,
    description: "Лёгкая, складывается в собственный карман, водоотталкивающая пропитка.",
    colors: ["#3A3D42"], sizes: SIZES, soldOutSizes: ["S"], photo: img("6"), photoPosition: "75% 30%", photoAuthor: "Liliana Drew" },
  { id: 7, category: "street", name: "Кроссовки Street Low", price: 12990, isNew: true,
    description: "Баскетбольный силуэт в ретро-стиле: кожаный верх, мягкий язычок, резиновая подошва с протектором.",
    colors: ["#1B1B1F", "#8A8F96", "#B3122E"],
    colorNames: { "#1B1B1F": "Чёрно-белый", "#8A8F96": "Серый", "#B3122E": "Красно-жёлтый" },
    swatches: { "#1B1B1F": "linear-gradient(135deg,#F4F6F8 50%,#1B1B1F 50%)", "#8A8F96": "linear-gradient(135deg,#D9DDE2 50%,#5A5F66 50%)", "#B3122E": "linear-gradient(135deg,#F5A300 50%,#B3122E 50%)" },
    sizes: ["40", "41", "42", "43", "44", "45", "46"], soldOutSizes: ["46"],
    photo: img("7-panda"), colorPhotos: { "#1B1B1F": img("7-panda"), "#8A8F96": img("7-grey"), "#B3122E": img("7-red") },
    photoPosition: "50% 50%", photoAuthor: "Terrance Barksdale" },
  { id: 8, category: "run", name: "Кепка беговая Light", price: 1490, isNew: false,
    description: "Перфорированная ткань, регулируемый ремешок.",
    colors: ["#3A3D42"], sizes: ["One size"], photo: img("8"), photoPosition: "50% 22%", photoAuthor: "Ilya Dudnikov" },
  { id: 9, category: "street", name: "Свитшот Wave", price: 3990, isNew: true,
    description: "Хлопковый футер, свободный крой, крупный принт на груди, мягкие манжеты.",
    colors: ["#F2F2F0"], colorNames: { "#F2F2F0": "Белый" }, sizes: SIZES, photo: img("9"), photoPosition: "50% 38%", photoAuthor: "Ahmed Aziz" },
  { id: 10, category: "run", name: "Лонгслив компрессионный Pulse", price: 3490, isNew: true,
    description: "Облегающий крой, бесшовная вязка с зонами вентиляции. Держит мышцы на длинной дистанции и не натирает.",
    colors: ["#E4E8EC"], sizes: SIZES,
    photo: "10-pants.jpg", photoPosition: "50% 40%", photoAuthor: "Gustavo Fring" },
];
