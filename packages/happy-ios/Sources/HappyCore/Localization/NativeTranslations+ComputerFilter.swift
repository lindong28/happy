extension TranslationCatalog {
    static let computerFilterSources: [String: [String: String]] = [
        "en": words("Computer", "All computers", "Computer unavailable", "My computers"),
        "zh-Hans": words("电脑", "全部电脑", "电脑不可用", "我的电脑"),
        "zh-Hant": words("電腦", "全部電腦", "電腦無法使用", "我的電腦"),
        "ja": words("コンピュータ", "すべてのコンピュータ", "コンピュータを利用できません", "自分のコンピュータ"),
        "ru": words("Компьютер", "Все компьютеры", "Компьютер недоступен", "Мои компьютеры"),
        "pl": words("Komputer", "Wszystkie komputery", "Komputer niedostępny", "Moje komputery"),
        "es": words("Ordenador", "Todos los ordenadores", "Ordenador no disponible", "Mis ordenadores"),
        "it": words("Computer", "Tutti i computer", "Computer non disponibile", "I miei computer"),
        "pt": words("Computador", "Todos os computadores", "Computador indisponível", "Meus computadores"),
        "ca": words("Ordinador", "Tots els ordinadors", "Ordinador no disponible", "Els meus ordinadors"),
    ]

    private static func words(_ title: String, _ all: String, _ unavailable: String, _ myComputers: String) -> [String: String] {
        ["native.computerFilter.title": title, "native.computerFilter.all": all, "native.computerFilter.unavailable": unavailable, "native.computerFilter.myComputers": myComputers]
    }
}
