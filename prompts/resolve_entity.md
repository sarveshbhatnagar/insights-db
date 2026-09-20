Task: decide whether a name from a document refers to one of the existing
entities.

Name: {name} ({type}), from a document about: {event_title}

Candidates:
{id} | {name} | {type} | also known as: {aliases}
...

Reply schema:
{ "match": "<candidate id>" | null }

Match only when you are confident both are the same real-world entity. A parent
company and its subsidiary, a person and the office they hold, a city and its
country are different entities. When unsure, reply null: a missed match can be
merged later, while a wrong match corrupts two records.

<owner_guidance>
{guidance}
</owner_guidance>
