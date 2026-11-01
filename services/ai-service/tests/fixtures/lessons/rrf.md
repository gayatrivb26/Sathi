# Hybrid search and reciprocal rank fusion

Hybrid search runs a vector search and a keyword search and merges the two ranked lists.

## Reciprocal rank fusion

Reciprocal rank fusion gives each document a score of one over k plus its rank in each list, and adds the scores across lists. A common choice is k equal to 60. Documents that rank well in both lists rise to the top, and the method needs no score normalisation.
