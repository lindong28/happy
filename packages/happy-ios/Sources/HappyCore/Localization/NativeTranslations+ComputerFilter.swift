extension TranslationCatalog {
    static let computerFilterSources: [String: [String: String]] = [
        "en": words("Computer", "All computers", "Computer unavailable"),
        "zh-Hans": words("电脑", "全部电脑", "电脑不可用"),
        "zh-Hant": words("電腦", "全部電腦", "電腦無法使用"),
        "ja": words("コンピュータ", "すべてのコンピュータ", "コンピュータを利用できません"),
        "ru": words("Компьютер", "Все компьютеры", "Компьютер недоступен"),
        "pl": words("Komputer", "Wszystkie komputery", "Komputer niedostępny"),
        "es": words("Ordenador", "Todos los ordenadores", "Ordenador no disponible"),
        "it": words("Computer", "Tutti i computer", "Computer non disponibile"),
        "pt": words("Computador", "Todos os computadores", "Computador indisponível"),
        "ca": words("Ordinador", "Tots els ordinadors", "Ordinador no disponible"),
    ]

    private static func words(_ title: String, _ all: String, _ unavailable: String) -> [String: String] {
        ["native.computerFilter.title": title, "native.computerFilter.all": all, "native.computerFilter.unavailable": unavailable]
    }
}
