# Смежные стеки для сравнения рынка (обновлено: апрель 2026)
# Источник: Perplexity Sonar Pro, данные рынка 2026
# Критерии: больше вакансий, выше зарплата, ниже конкуренция
# Обновлять вручную раз в ~6 месяцев
#
# Промпт для обновления (отправить в Perplexity Sonar Pro):
# ---
# I need to build a transition map for developers. For each technology below,
# suggest the top 2 alternative technologies that a developer SHOULD consider
# switching to, based strictly on these criteria (in order of priority):
# 1. MORE job vacancies globally (bigger market = better)
# 2. HIGHER median salary
# 3. LOWER competition (fewer candidates per vacancy)
#
# Do NOT recommend technologies with fewer vacancies than the source.
# Do NOT recommend niche technologies (like Flutter, Svelte, .NET MAUI).
# Prefer mainstream, high-demand technologies.
#
# For mobile developers (Swift, Kotlin, Flutter, React Native): consider that
# native iOS/Android development often has more vacancies than cross-platform.
#
# Technologies: React, Vue, Angular, Svelte, Java, Kotlin, Scala, Python, Go,
# Ruby, PHP, .NET/C#, Node.js, Rust, C++, Swift, Flutter, React Native, TypeScript.
#
# Return ONLY a valid JSON object with lowercase keys.
# Format: {"react": ["alt1", "alt2"], "java": ["alt1", "alt2"], ...}
# ---
#
# Формат: стек: альтернатива1, альтернатива2

react: angular, vue
vue: react, angular
angular: react, vue
svelte: react, angular
java: python, .net
kotlin: java, swift
scala: java, python
python: java, .net
go: python, java
ruby: python, java
php: python, java
.net: java, python
node.js: python, java
rust: python, go
c++: java, python
swift: kotlin, java
flutter: swift, kotlin
react-native: swift, kotlin
typescript: react, angular
